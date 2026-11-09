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
import androidx.compose.runtime.mutableIntStateOf
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
    private val inbox: InboxViewModel by viewModels()
    private val vm: RelayViewModel by viewModels()
    private var formConsentId: String? = null
    private val formConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        inbox.consentResult(formConsentId, result.resultCode == Activity.RESULT_OK, result.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE))
        formConsentId = null
    }
    private var destination by mutableStateOf<RelayDestination>(RelayDestination.Inbox)
    private var loadedTarget by mutableStateOf<RequestTarget?>(null)
    private var responseLoading by mutableStateOf(false)
    private var responseAttempt by mutableIntStateOf(0)
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
        destination = if (savedInstanceState != null) restoreDestination(savedInstanceState.getStringArrayList("destination"))
            else intentDestination(intent)
        launchedConsentRequestId = savedInstanceState?.getString("launchedConsentRequestId")
        formConsentId = savedInstanceState?.getString("formConsentId")
        pendingConnectionCode = if (savedInstanceState == null) connectionCode(intent) else savedInstanceState.getString("connectionCode")
        setContent {
            val inboxState = inbox.state.collectAsStateWithLifecycle().value
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
            val response = destination as? RelayDestination.Response
            LaunchedEffect(response, responseAttempt, state.signedIn, state.registered) {
                loadedTarget = null
                responseLoading = false
                if (response != null && state.configured) {
                    responseLoading = true
                    val loaded = loadResponseWhenReady(response.target, vm.state, inbox.state,
                        openSms = { vm.open(it).await() }, openForm = {
                            if (response.origin == RequestOrigin.Notification) recordTap(intent)
                            inbox.open(it).await()
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
                    responseReady = response != null && loadedTarget == response.target, responseLoading = responseLoading,
                    onSettings = { destination = RelayDestination.Settings() },
                    onSection = { destination = RelayDestination.Settings(it) }, onBack = ::closeDestination,
                    onRetry = { responseAttempt++ }, onSignIn = ::signIn, onRegister = ::register,
                    onRefresh = { vm.refresh(); inbox.refresh() }, onCancel = { vm.cancel() },
                    onRevoke = { vm.revoke(it) }, onSubmitCode = { vm.upload(it) }, onCodeChange = vm::changeCode,
                    onSelectCandidate = vm::selectCandidate,
                    onRequestSent = { if (response != null && destination == response) closeDestination() }, onDelete = { vm.deleteAccount() },
                    onReviewConnection = { vm.reviewConnection(it) }, onConnectionDecision = { code, approved -> vm.decideConnection(code, approved) },
                    onDismissConnection = vm::dismissConnection,
                    onOpenForm = { openFromInbox(it, RequestKind.Form) }, onOpenSms = { openFromInbox(it, RequestKind.Sms) },
                    onApproveForms = { id, approved -> vm.approveForms(id, approved) },
                    onPauseDevice = { vm.pauseDevice(it) }, onRemoveDevice = { vm.removeDevice(it) },
                    onFormChange = inbox::change, onFormSubmit = { inbox.submit(it) }, onFormRendered = inbox::rendered,
                    onFormListen = { inbox.listen(it) }, onFormCandidate = inbox::candidate, onFormNext = inbox::next, onFormPrevious = inbox::previous)
            }
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        destination = intentDestination(intent)
        // Repeated taps retry a failed load without creating another activity/session.
        responseAttempt++
        pendingConnectionCode = connectionCode(intent)
    }
    private fun intentDestination(intent: Intent): RelayDestination {
        requestId(intent)?.let { id ->
            val kind = if (intent.getStringExtra("kind") == "form") RequestKind.Form else RequestKind.Sms
            return RelayDestination.Response(RequestTarget(id, kind), RequestOrigin.Notification)
        }
        return if (connectionCode(intent) != null) RelayDestination.Settings(SettingsSection.Access) else RelayDestination.Inbox
    }
    private fun openFromInbox(id: String, kind: RequestKind) {
        destination = RelayDestination.Response(RequestTarget(id, kind), RequestOrigin.Inbox)
    }
    private fun closeDestination() {
        if (destination.backgroundOnClose()) {
            // Keep the task and ViewModels alive, including drafts and Android listening windows.
            moveTaskToBack(true)
            destination = RelayDestination.Inbox
        } else {
            if ((destination as? RelayDestination.Response)?.target?.kind == RequestKind.Form) inbox.close()
            destination = RelayDestination.Inbox
        }
    }
    private fun recordTap(intent: Intent) {
        if (intent.getBooleanExtra("notificationTap", false) && intent.getStringExtra("kind") == "form") requestId(intent)?.let { reportObservation(this, it, "notification.tapped") }
    }
    private fun requestId(intent: Intent) = intent.getStringExtra("requestId")?.takeIf { RelayNotifications.validId.matches(it) }
    private fun connectionCode(intent: Intent): String? {
        if (intent.action != Intent.ACTION_VIEW) return null
        return intent.dataString?.let { ConnectionLinks.code(it, BuildConfig.RELAY_URL) }
    }

    override fun onResume() { super.onResume(); vm.foreground(true); inbox.foreground(true) }
    override fun onStop() { vm.foreground(false); inbox.foreground(false); super.onStop() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("formConsentId", formConsentId)
        outState.putStringArrayList("destination", ArrayList(destination.metadata()))
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
