package com.bluegrain.smsrelay

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import kotlinx.coroutines.CancellationException
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val vm: RelayViewModel by viewModels()
    private var notificationRequest: String? = null
    private var pendingConnectionCode by mutableStateOf<String?>(null)
    private var launchedConsentRequestId by mutableStateOf<String?>(null)
    private val consent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val requestId = launchedConsentRequestId
        launchedConsentRequestId = null
        vm.consentResult(requestId, result.resultCode == Activity.RESULT_OK, result.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE))
    }
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) vm.register() else vm.error("Enable notifications in Android settings before registering this phone.")
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        notificationRequest = savedInstanceState?.getString("notificationRequest") ?: requestId(intent)
        launchedConsentRequestId = savedInstanceState?.getString("launchedConsentRequestId")
        pendingConnectionCode = if (savedInstanceState == null) connectionCode(intent) else savedInstanceState.getString("connectionCode")
        setContent {
            val state = vm.state.collectAsStateWithLifecycle().value
            var registrationAttempted by rememberSaveable { mutableStateOf(state.registered) }
            LaunchedEffect(state.signedIn, state.registered, state.busy, pendingConnectionCode) {
                if (state.signedIn && pendingConnectionCode == null && state.autoConnect && !state.registered && !state.busy && !registrationAttempted) {
                    registrationAttempted = true
                    register()
                }
            }
            LaunchedEffect(state.signedIn, state.busy, pendingConnectionCode) {
                if (state.signedIn && !state.busy) pendingConnectionCode?.let {
                    pendingConnectionCode = null
                    vm.reviewConnection(it)
                }
            }
            LaunchedEffect(state.signedIn, notificationRequest) {
                if (state.signedIn) notificationRequest?.let { notificationRequest = null; vm.open(it) }
            }
            LaunchedEffect(state.consentAvailable, state.foreground, launchedConsentRequestId) {
                if (launchedConsentRequestId == null) vm.takeConsent()?.let { (id, next) ->
                    launchedConsentRequestId = id
                    try { consent.launch(next) } catch (_: Exception) { launchedConsentRequestId = null; vm.consentUnavailable() }
                }
            }
            RelayTheme {
                RelayScreen(state, onSignIn = ::signIn, onRegister = ::register,
                    onRefresh = { vm.refresh() }, onPause = { vm.pause() }, onCancel = { vm.cancel() },
                    onRevoke = { vm.revoke(it) }, onSubmitCode = { vm.upload(it) }, onCodeChange = { id, value -> vm.changeCode(id, value) },
                    onSelectCandidate = { id, value -> vm.selectCandidate(id, value) }, onDismissRequest = vm::dismissRequest, onRequestSent = ::finishAndRemoveTask, onDelete = { vm.deleteAccount() },
                    onReviewConnection = { vm.reviewConnection(it) }, onConnectionDecision = { code, approved -> vm.decideConnection(code, approved) },
                    onDismissConnection = vm::dismissConnection,
                    onPauseDevice = { vm.pauseDevice(it) }, onRemoveDevice = { vm.removeDevice(it) })
            }
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        notificationRequest = requestId(intent)
        pendingConnectionCode = connectionCode(intent)
        if (vm.state.value.signedIn) notificationRequest?.let { notificationRequest = null; vm.open(it) }
    }
    private fun requestId(intent: Intent) = intent.getStringExtra("requestId")?.takeIf { RelayNotifications.validId.matches(it) }
    private fun connectionCode(intent: Intent): String? {
        if (intent.action != Intent.ACTION_VIEW) return null
        return intent.dataString?.let { ConnectionLinks.code(it, BuildConfig.RELAY_URL) }
    }

    override fun onResume() { super.onResume(); vm.foreground(true) }
    override fun onStop() { vm.foreground(false); super.onStop() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("notificationRequest", notificationRequest)
        outState.putString("connectionCode", pendingConnectionCode)
        outState.putString("launchedConsentRequestId", launchedConsentRequestId)
        super.onSaveInstanceState(outState)
    }
    private fun register() {
        if (Build.VERSION.SDK_INT >= 33 && !RelayNotifications.enabled(this)) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        else if (RelayNotifications.enabled(this)) vm.register()
        else vm.error("Enable the code request notification channel in Android settings.")
    }
    private fun signIn() {
        lifecycleScope.launch {
            try {
                val option = GetGoogleIdOption.Builder().setServerClientId(BuildConfig.GOOGLE_WEB_CLIENT_ID)
                    .setFilterByAuthorizedAccounts(false).setAutoSelectEnabled(false).build()
                val result = CredentialManager.create(this@MainActivity).getCredential(this@MainActivity,
                    GetCredentialRequest.Builder().addCredentialOption(option).build())
                val credential = result.credential
                if (credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    vm.signedIn(GoogleIdTokenCredential.createFrom(credential.data).idToken)
                } else vm.error("Choose a Google account to continue.")
            } catch (e: CancellationException) { throw e }
            catch (_: NoCredentialException) { vm.error("Add a Google account to this phone, then try again.") }
            catch (_: GetCredentialCancellationException) { vm.error("Google sign-in was cancelled.") }
            catch (_: Exception) { vm.error("Google sign-in was not completed. Try again when ready.") }
        }
    }
}
