package com.bluegrain.smsrelay

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.android.gms.auth.api.phone.SmsRetriever

class MainActivity : AccountActivity() {
    private val inbox: InboxViewModel by viewModels()
    private var formConsentId: String? = null
    private val formConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        inbox.consentResult(formConsentId, result.resultCode == Activity.RESULT_OK, result.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE))
        formConsentId = null
    }
    private var destination by mutableStateOf<RelayDestination>(RelayDestination.Inbox)
    private var pendingInboxTarget by mutableStateOf<RequestTarget?>(null)
    private var loadedTarget by mutableStateOf<RequestTarget?>(null)
    private var refreshing by mutableStateOf(false)
    private var responseLoading by mutableStateOf(false)
    private var responseAttempt by mutableIntStateOf(0)
    private var launchedConsentRequestId by mutableStateOf<String?>(null)
    private val consent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val requestId = launchedConsentRequestId
        launchedConsentRequestId = null
        vm.consentResult(requestId, result.resultCode == Activity.RESULT_OK, result.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE))
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        destination = if (savedInstanceState != null) restoreDestination(savedInstanceState.getStringArrayList("destination"))
            else intentDestination(intent)
        responseLoading = destination is RelayDestination.Response
        launchedConsentRequestId = savedInstanceState?.getString("launchedConsentRequestId")
        formConsentId = savedInstanceState?.getString("formConsentId")
        setContent {
            val inboxState = inbox.state.collectAsStateWithLifecycle().value
            val state = vm.state.collectAsStateWithLifecycle().value
            var registrationAttempted by rememberSaveable { mutableStateOf(state.registered) }
            LaunchedEffect(state.signedIn, state.registered, state.busy) {
                if (state.signedIn && state.autoConnect && !state.registered && !state.busy && !registrationAttempted) {
                    registrationAttempted = true
                    register()
                }
            }
            val response = destination as? RelayDestination.Response
            BackHandler(enabled = pendingInboxTarget != null) { pendingInboxTarget = null }
            LaunchedEffect(pendingInboxTarget, responseAttempt) {
                val target = pendingInboxTarget ?: return@LaunchedEffect
                val loaded = loadResponseWhenReady(target, vm.state, inbox.state,
                    openSms = { vm.open(it).await() }, openForm = { inbox.open(it).await() })
                if (pendingInboxTarget == target) {
                    pendingInboxTarget = null
                    if (loaded) {
                        loadedTarget = target
                        responseLoading = false
                        destination = RelayDestination.Response(target, RequestOrigin.Inbox)
                    }
                }
            }
            LaunchedEffect(response, responseAttempt, state.signedIn, state.registered) {
                if (response == null) {
                    loadedTarget = null
                    responseLoading = false
                } else if (state.configured && (loadedTarget != response.target || !state.signedIn || !state.registered)) {
                    if (!state.signedIn || !state.registered) loadedTarget = null
                    responseLoading = true
                    val loaded = loadResponseWhenReady(response.target, vm.state, inbox.state,
                        openSms = { vm.open(it).await() }, openForm = { inbox.open(it).await() }, onFormEntry = {
                            if (response.origin == RequestOrigin.Notification) recordTap(intent)
                        })
                    if (loaded) loadedTarget = response.target
                    responseLoading = false
                }
            }
            LaunchedEffect(state.consentAvailable, state.foreground, launchedConsentRequestId, response, loadedTarget) {
                if (response?.target?.kind == RequestKind.Sms && loadedTarget == response.target && launchedConsentRequestId == null) vm.takeConsent()?.let { (id, next) ->
                    launchedConsentRequestId = id
                    try { consent.launch(next) } catch (_: Exception) { launchedConsentRequestId = null; vm.consentUnavailable() }
                }
            }
            LaunchedEffect(state.registered, state.signedIn) { inbox.sessionChanged() }
            LaunchedEffect(inboxState.consent, inboxState.foreground, response, loadedTarget) {
                if (response?.target?.kind == RequestKind.Form && loadedTarget == response.target && formConsentId == null) inbox.takeConsent()?.let { (id, next) ->
                    formConsentId = id
                    try { formConsent.launch(next) } catch (_: Exception) { inbox.consentResult(id, false, null); formConsentId = null }
                }
            }
            RelayTheme {
                RelayScreen(state.copy(busy = state.busy || inboxState.busy, error = if (destination == RelayDestination.Inbox) inboxState.error ?: state.error else state.error),
                    destination = destination, formState = inboxState, deviceId = (application as RelayApplication).repository.deviceId,
                    openingTarget = pendingInboxTarget, refreshing = refreshing, responseReady = response != null && loadedTarget == response.target, responseLoading = responseLoading,
                    onAdministration = ::openAdministration, onBack = ::closeDestination,
                    onRetry = { responseLoading = true; responseAttempt++ }, onSignIn = ::signIn, onRegister = ::register,
                    onRefresh = ::refreshFeed, onCancel = { vm.cancel() },
                    onSubmitCode = { vm.upload(it) }, onCodeChange = vm::changeCode,
                    onSelectCandidate = vm::selectCandidate,
                    onRequestSent = { if (response != null && destination == response) closeDestination() },
                    onOpenForm = { openFromInbox(it, RequestKind.Form) }, onOpenSms = { openFromInbox(it, RequestKind.Sms) },
                    onFormChange = inbox::change, onFormSubmit = { inbox.submit(it) }, onFormRendered = inbox::rendered,
                    onFormListen = { inbox.listen(it) }, onFormCandidate = inbox::candidate, onFormNext = inbox::next, onFormPrevious = inbox::previous)
            }
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        pendingInboxTarget = null
        val next = intentDestination(intent)
        if (next != destination || (next is RelayDestination.Response && loadedTarget != next.target)) {
            loadedTarget = null
            responseLoading = next is RelayDestination.Response
        }
        destination = next
        // Repeated taps retry a failed load without creating another activity/session.
        responseAttempt++
    }
    private fun intentDestination(intent: Intent): RelayDestination {
        requestId(intent)?.let { id ->
            val kind = if (intent.getStringExtra("kind") == "form") RequestKind.Form else RequestKind.Sms
            return RelayDestination.Response(RequestTarget(id, kind), RequestOrigin.Notification)
        }
        return RelayDestination.Inbox
    }
    private fun openFromInbox(id: String, kind: RequestKind) {
        val target = RequestTarget(id, kind)
        val state = vm.state.value
        if (!state.configured || !state.signedIn || !state.registered) {
            loadedTarget = null
            responseLoading = true
            destination = RelayDestination.Response(target, RequestOrigin.Inbox)
        } else {
            pendingInboxTarget = target
        }
    }
    private fun closeDestination() {
        if ((destination as? RelayDestination.Response)?.target?.kind == RequestKind.Form) inbox.close()
        if (destination.backgroundOnClose()) {
            // Keep the task and ViewModels alive, including drafts and Android listening windows.
            moveTaskToBack(true)
            destination = RelayDestination.Inbox
        } else {
            destination = RelayDestination.Inbox
        }
    }
    private fun recordTap(intent: Intent) {
        if (intent.getBooleanExtra("notificationTap", false) && intent.getStringExtra("kind") == "form") requestId(intent)?.let { reportObservation(this, it, "notification.tapped") }
    }
    private fun requestId(intent: Intent) = intent.getStringExtra("requestId")?.takeIf { RelayNotifications.validId.matches(it) }
    private fun refreshFeed() {
        if (refreshing || vm.state.value.busy) return
        lifecycleScope.launch {
            refreshing = true
            try { vm.refresh().join(); inbox.refresh().join() } finally { refreshing = false }
        }
    }
    private fun openAdministration() {
        startActivity(Intent(this, AdministrationActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    override fun onResume() { super.onResume(); vm.foreground(true); inbox.foreground(true) }
    override fun onStop() { vm.foreground(false); inbox.foreground(false); super.onStop() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("formConsentId", formConsentId)
        val retainedDestination = pendingInboxTarget?.let { RelayDestination.Response(it, RequestOrigin.Inbox) } ?: destination
        outState.putStringArrayList("destination", ArrayList(retainedDestination.metadata()))
        outState.putString("launchedConsentRequestId", launchedConsentRequestId)
        super.onSaveInstanceState(outState)
    }
}
