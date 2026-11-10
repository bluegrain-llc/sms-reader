package com.bluegrain.smsrelay

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.coroutines.launch
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class AdministrationActivity : AccountActivity() {
    override val administrationOnly = true
    private var pendingConnectionCode by mutableStateOf<String?>(null)
    private var linkVersion by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        pendingConnectionCode = if (savedInstanceState == null) connectionCode(intent) else savedInstanceState.getString("connectionCode")
        setContent {
            val state by vm.state.collectAsStateWithLifecycle()
            val scope = rememberCoroutineScope()
            var refreshing by remember { mutableStateOf(false) }
            var section by rememberSaveable(linkVersion) { mutableStateOf(AdministrationSection.Access) }
            LaunchedEffect(state.signedIn, state.busy, pendingConnectionCode) {
                if (state.signedIn && !state.busy) pendingConnectionCode?.let {
                    pendingConnectionCode = null
                    vm.reviewConnection(it)
                }
            }
            RelayTheme {
                AdministrationScreen(state, section, onSection = { section = it }, onClose = ::finish,
                    onSignIn = ::signIn, onRegister = ::register, refreshing = refreshing, onRefresh = {
                        if (!state.busy && !refreshing) scope.launch {
                            refreshing = true
                            try { vm.refresh().join() } finally { refreshing = false }
                        }
                    },
                    onRevoke = { vm.revoke(it) }, onDelete = ::deleteAccountWithReauthentication,
                    onPauseDevice = { vm.pauseDevice(it) }, onRemoveDevice = { vm.removeDevice(it) },
                    onApproveForms = { id, approved -> vm.approveForms(id, approved) },
                    onReviewConnection = { vm.reviewConnection(it) }, onConnectionDecision = { code, approved -> vm.decideConnection(code, approved) },
                    onDismissConnection = vm::dismissConnection)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        connectionCode(intent)?.let { pendingConnectionCode = it; linkVersion++ }
    }
    private fun connectionCode(intent: Intent): String? = if (intent.action == Intent.ACTION_VIEW)
        intent.dataString?.let { ConnectionLinks.code(it, BuildConfig.RELAY_URL) } else null

    override fun onResume() { super.onResume(); vm.foreground(true) }
    override fun onStop() { vm.foreground(false); super.onStop() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("connectionCode", pendingConnectionCode)
        super.onSaveInstanceState(outState)
    }
}
