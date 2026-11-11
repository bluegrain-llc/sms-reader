package com.bluegrain.smsrelay

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.async
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.IOException

// Sensitive values live only in this ViewModel. No saved state, disk, analytics, or crash logger.
data class GrantRow(val id: String, val name: String, val revoked: Boolean, val expiresAt: Long, val formsApproved: Boolean = false, val connectionId: String? = null, val capabilities: List<String>? = null)
data class DeviceRow(val id: String, val name: String, val paused: Boolean, val current: Boolean)
data class HistoryRow(val caller: String, val status: String, val reason: String?)
data class RelayUiState(
    val configured: Boolean = false, val signedIn: Boolean = false, val email: String = "",
    val registered: Boolean = false, val paused: Boolean = false, val busy: Boolean = false, val cancelling: Boolean = false,
    val request: PhoneRequest? = null, val grants: List<GrantRow> = emptyList(), val history: List<HistoryRow> = emptyList(),
    val candidates: List<String> = emptyList(), val codeDraft: String = "", val autofillDeclined: Boolean = false, val error: String? = null,
    val devices: List<DeviceRow> = emptyList(), val connection: ConnectionReview? = null, val connectionCode: String? = null,
    val autoConnect: Boolean = true, val discoveredRequest: PhoneRequest? = null,
    val consentAvailable: Boolean = false, val now: Long = System.currentTimeMillis(), val foreground: Boolean = false,
    val opening: Boolean = false,
)
class RelayViewModel @JvmOverloads constructor(application: Application, private val administrationOnly: Boolean = false) : AndroidViewModel(application) {
    private val app = application as RelayApplication
    private val repo get() = app.repository
    private val mutable = MutableStateFlow(RelayUiState(configured = app.configured))
    val state = mutable.asStateFlow()
    private val actions = UiActions(mutable, ::error)
    private val gate = ConsentGate()
    private var receiver: BroadcastReceiver? = null
    private var listenerWindow: SmsListenerWindow? = null
    private var consent: Intent? = null
    private var consentRequestId: String? = null
    private var consentLaunched = false
    private var boundId: String? = null
    private var poll: Job? = null
    private var blocked = false
    private var sessionOwner: String? = if (app.configured) repo.ownerId else null
    private var recovered = false
    private val recoveryMutex = Mutex()
    init {
        if (app.configured) mutable.update { it.copy(signedIn = repo.signedIn, email = repo.email, registered = repo.registered, autoConnect = repo.autoConnect) }
        viewModelScope.launch {
            var ticks = 0
            while (true) {
                mutable.update { it.copy(now = listenerNow(System.currentTimeMillis())) }
                // A bound SMS has its own poll; list refresh must not disable its code input.
                if (++ticks % 15 == 0 && state.value.foreground && app.configured && !state.value.busy &&
                    !state.value.opening && boundId == null) refresh(silent = true)
                delay(1_000)
            }
        }
        if (app.configured && repo.signedIn) refresh()
    }
    fun error(message: String) { mutable.update { it.copy(error = message) } }
    fun changeCode(id: String, value: String) {
        if (state.value.request?.id != id || state.value.request?.active != true || state.value.busy || blocked) return
        mutable.update { it.copy(codeDraft = value.take(64)) }
    }
    fun selectCandidate(id: String, code: String) {
        if (gate.permits(id, code)) {
            changeCode(id, code)
            upload(id, approvedCode = code)
        }
    }
    fun dismissConnection() { mutable.update { it.copy(connection = null, connectionCode = null) } }
    private fun action(waitForIdle: Boolean = false, silent: Boolean = false, block: suspend () -> Unit) = viewModelScope.launch {
        actions.run(waitForIdle, silent, block)
    }
    fun signedIn(token: String, deleteAfter: Boolean = false, expectedOwner: String = "") = viewModelScope.launch {
        actions.credentials {
            check(!deleteAfter || (expectedOwner.isNotBlank() && repo.signedIn && repo.ownerId == expectedOwner)) { "Sign in to the account again before deleting." }
            repo.signIn(token)
            if (deleteAfter) {
                repo.deleteAccount(); clearLocal()
                mutable.update { RelayUiState(configured = app.configured, foreground = it.foreground, error = "Deletion accepted. Account access is blocked while cleanup continues.") }
                return@credentials
            }
            mutable.update { it.copy(signedIn = true, email = repo.email) }
            refreshData()
        }
    }
    fun register(resumePaused: Boolean = false) = action {
        check(RelayNotifications.enabled(app)) { "Notifications required" }
        val paused = registerReceivingPhone(resumePaused,
            register = { repo.register().getBoolean("paused") }, resume = { repo.pause(false) })
        mutable.update { it.copy(registered = true, paused = paused, autoConnect = true) }
        refreshData()
    }
    fun refresh(silent: Boolean = false) = action(silent = silent) { if (app.configured) refreshData() }
    private suspend fun refreshData() {
        val owner = repo.ownerId
        if (owner != sessionOwner) {
            clearLocal()
            sessionOwner = owner
            recovered = false
            mutable.update { RelayUiState(configured = app.configured, foreground = it.foreground, busy = it.busy) }
        }
        mutable.update { it.copy(signedIn = repo.signedIn, email = repo.email, registered = repo.registered, autoConnect = repo.autoConnect) }
        if (!repo.signedIn) return
        // Administration never owns or recovers the Inbox's SMS listening session.
        if (!administrationOnly) recover()
        val devices = repo.devices()
        val d = (0 until devices.length()).map { devices.getJSONObject(it) }.find { it.optString("deviceId") == repo.deviceId }
        if (d == null && repo.registered) repo.autoConnect = false
        repo.registered = d != null
        if (d != null && d.optInt("wizardVersion") != 1) repo.register()
        mutable.update { it.copy(registered = d != null, autoConnect = repo.autoConnect, paused = d?.getBoolean("paused") ?: false,
            devices = (0 until devices.length()).map { devices.getJSONObject(it).let { row ->
                DeviceRow(row.getString("deviceId"), row.getString("name"), row.getBoolean("paused"), row.getString("deviceId") == repo.deviceId) } }) }
        if (administrationOnly) {
            val grants = repo.grants()
            val history = repo.history()
            mutable.update { s -> s.copy(grants = (0 until grants.length()).map { grants.getJSONObject(it).let { g ->
                GrantRow(g.getString("grantId"), g.getString("callerName"), g.getBoolean("revoked"), g.getLong("expiresAt"), g.optBoolean("formsApproved"), g.nullString("connectionId"), g.optJSONArray("capabilities")?.let { a -> (0 until a.length()).map { a.getString(it) } }) } },
                history = (0 until history.length()).map { history.getJSONObject(it).let { h -> HistoryRow(h.optString("callerName"), h.getString("status"), h.nullString("reason")) } }) }
        }
        // Discover missed requests for Inbox; only an explicit open starts SMS reception.
        if (!administrationOnly) refreshSmsDiscovery(d?.nullString("activeRequestId"), { boundId != null }, repo::request) { request ->
            mutable.update { it.withSmsDiscovery(request) }
        }
    }
    private suspend fun recover() = recoveryMutex.withLock {
        if (recovered) return@withLock
        repo.inFlight?.let { lost ->
            if (boundId == null) {
                try {
                    val r = repo.request(lost)
                    if (r.active) repo.event(lost, "failed", reason = "process_restarted")
                } catch (e: ApiFailure) {
                    if (e.status !in setOf(404, 409)) throw e
                }
                repo.inFlight = null
            }
        }
        recovered = true
    }
    fun approveForms(id: String, approved: Boolean) = action { repo.approveForms(id, approved); refreshData() }
    fun revoke(id: String) = action { repo.revoke(id); refreshData() }
    fun reviewConnection(code: String) = viewModelScope.launch {
        mutable.update { it.copy(connection = null, connectionCode = code) }
        // A link arriving during registration/refresh must survive that in-flight action.
        while (state.value.busy) delay(100)
        action {
            val result = repo.reviewConnection(code)
            mutable.update { it.copy(connection = result) }
        }.join()
    }
    fun decideConnection(code: String, approved: Boolean) = action {
        if (state.value.connection?.code != code) return@action
        val result = repo.decideConnection(code, approved)
        mutable.update { it.copy(connection = result) }
        refreshData()
    }
    fun pauseDevice(id: String) = action {
        val device = state.value.devices.find { it.id == id } ?: return@action
        repo.pause(!device.paused, id)
        if (device.current) state.value.request?.id?.let { sync(it) }
        refreshData()
    }
    fun removeDevice(id: String) = action {
        val current = state.value.devices.find { it.id == id }?.current == true
        repo.unregister(id)
        if (current) clearLocal()
        refreshData()
    }
    fun pause() = action {
        repo.pause(!state.value.paused)
        state.value.request?.id?.let { sync(it) }
        refreshData()
    }
    fun unregister() = action { repo.unregister(); clearLocal(); refreshData() }
    fun deleteAccount() = action {
        repo.deleteAccount(); clearLocal()
        mutable.update { RelayUiState(configured = app.configured, foreground = it.foreground) }
    }
    fun foreground(value: Boolean) {
        mutable.update { it.copy(foreground = value) }
        if (!value) {
            if (consent != null) state.value.request?.id?.let { RelayNotifications.show(app, it, true) }
        } else if (app.configured && !state.value.opening) refresh(silent = true)
    }
    fun open(id: String) = viewModelScope.async {
        while (state.value.busy || state.value.opening) delay(50)
        if (administrationOnly || !RelayNotifications.validId.matches(id) || !app.configured || !repo.signedIn) return@async false
        if (state.value.request.blocksSmsOpen(boundId, id)) { error("Finish or cancel the current request first."); return@async false }
        mutable.update { it.copy(busy = true, opening = true, error = null) }
        var loaded = false
        try {
            recover()
            val r = repo.request(id)
            if (boundId != id) clearSensitive()
            mutable.update { it.copy(request = r, error = null) }
            loaded = true
            RelayNotifications.dismiss(app, id)
            if (!r.active) return@async true
            if (boundId == id) { startPoll(id); return@async true }
            if (r.status != "pending_phone") {
                repo.event(id, "failed", reason = "process_restarted"); sync(id); return@async true
            }
            if (repo.listenerUntil > System.currentTimeMillis()) {
                error("The previous Android listening window is still open. Start a new request after it ends.")
                repo.event(id, "failed", reason = "listener_failed"); sync(id); return@async true
            }
            startListener(r)
        } catch (e: CancellationException) { throw e }
        catch (e: ApiFailure) { error(e.reason.replace('_', ' ')) }
        catch (_: Exception) { error("Could not open this request. Check your network and retry.") }
        finally { mutable.update { it.copy(busy = false, opening = false) } }
        loaded
    }
    private suspend fun startListener(r: PhoneRequest) {
        val available = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app) == ConnectionResult.SUCCESS
        val reason = if (!available) "play_services_unavailable" else if (!RelayNotifications.enabled(app)) "notifications_disabled" else null
        if (reason != null) { repo.event(r.id, "failed", reason); sync(r.id); return }
        boundId = r.id; blocked = false; repo.inFlight = r.id; gate.bind(r.id)
        val started = System.currentTimeMillis()
        val window = SmsListenerWindow(SystemClock.elapsedRealtime(), minOf(r.expiresAt, r.listeningDeadline ?: Long.MAX_VALUE) - started, started, SystemClock::elapsedRealtime)
        listenerWindow = window
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION || boundId != r.id || blocked) return
                val status = IntentCompat.getParcelableExtra(intent, SmsRetriever.EXTRA_STATUS, Status::class.java) ?: return
                onListenerStatus(r.id, window, status.statusCode,
                    IntentCompat.getParcelableExtra(intent, SmsRetriever.EXTRA_CONSENT_INTENT, Intent::class.java))
            }
        }
        ContextCompat.registerReceiver(app, receiver, IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION), SmsRetriever.SEND_PERMISSION, null, ContextCompat.RECEIVER_EXPORTED)
        try {
            repo.listenerUntil = started + 5 * 60_000
            SmsRetriever.getClient(app).startSmsUserConsent(r.sender).await()
            if (listenerWindow !== window || blocked || boundId != r.id) return
            val ready = retry(r.id) { repo.event(r.id, "ready", startedAt = started) }
            if (listenerWindow !== window || blocked || boundId != r.id) return
            if (ready.getString("status") != "ready") { window.close(); sync(r.id); return }
            window.shortenTo(minOf(r.expiresAt, ready.optLong("expiresAt", r.expiresAt), ready.optLong("listeningDeadline", Long.MAX_VALUE)) - started)
            window.ready.complete(true)
            sync(r.id); startPoll(r.id)
        } catch (e: CancellationException) { window.close(); throw e }
        catch (_: Exception) { window.close(); if (listenerWindow === window) fail(r.id, "listener_failed") }
    }
    private fun onListenerStatus(id: String, window: SmsListenerWindow, status: Int, next: Intent?) = viewModelScope.launch {
        if (!window.accepts(status == CommonStatusCodes.TIMEOUT) {
                listenerWindow === window && boundId == id && !blocked && state.value.request?.let { it.id == id && it.active } == true
            }) return@launch
        when (status) {
            CommonStatusCodes.SUCCESS -> {
                if (next == null) { fail(id, "consent_unavailable"); return@launch }
                try {
                    val outcome = retry(id) { repo.event(id, "awaiting_consent") }
                    if (listenerWindow !== window || blocked || boundId != id || window.expired()) return@launch
                    if (outcome.getString("status") != "awaiting_consent") { sync(id); return@launch }
                    consent = next; consentRequestId = id
                    mutable.update { it.copy(consentAvailable = true) }
                    if (!state.value.foreground) RelayNotifications.show(app, id, true)
                } catch (_: IOException) {
                    if (listenerWindow === window) { error("Connection lost before consent. Reopen this request to retry."); fail(id, "consent_unavailable") }
                }
            }
            CommonStatusCodes.TIMEOUT -> fail(id, "listener_timeout")
        }
    }
    private suspend fun <T> retry(id: String, block: suspend () -> T): T {
        var wait = 1_000L
        repeat(4) { attempt ->
            if (blocked || boundId != id) throw IOException("request_inactive")
            try { return block() } catch (e: ApiFailure) { if (e.status < 500) throw e }
            catch (e: IOException) { if (attempt == 3) throw e }
            if (attempt < 3) { delay(wait); wait *= 2 }
        }
        throw IOException("connection_failed")
    }
    private fun startPoll(id: String) {
        poll?.cancel()
        poll = viewModelScope.launch {
            while (state.value.request?.active == true && boundId == id) {
                delay(2_000)
                try { sync(id) } catch (e: ApiFailure) {
                    if (e.status in setOf(401, 403, 404, 409)) { clearLocal(); error("This request is no longer available."); return@launch }
                } catch (_: IOException) { error("Offline. Approval will stop when the listening window ends.") }
                val r = state.value.request
                if (!blocked && boundId == id && r?.id == id && r.active && listeningWindowEnded(System.currentTimeMillis())) {
                    if (listenerWindow != null) {
                        fail(id, "listener_timeout")
                        return@launch
                    }
                    clearSensitive(); error("Listening window ended. Ask the caller to start a new request.")
                }
            }
        }
    }
    private fun listenerNow(wallNow: Long) = listenerWindow?.now(wallNow) ?: wallNow
    private fun listeningWindowEnded(now: Long): Boolean = listenerWindow?.expired()
        ?: state.value.request?.let { now >= (it.listeningDeadline ?: it.expiresAt) } ?: false
    private suspend fun sync(id: String) {
        applyRequest(repo.request(id))
    }
    private fun applyRequest(r: PhoneRequest) {
        val id = r.id
        mutable.update { it.copy(request = r) }
        if (!r.active) { poll?.cancel(); repo.inFlight = null; clearSensitive(); unregisterReceiver(); boundId = null; RelayNotifications.dismiss(app, id) }
    }
    fun takeConsent(): Pair<String, Intent>? {
        if (!state.value.foreground || blocked || consentLaunched) return null
        val next = consent ?: return null
        consent = null; consentLaunched = true
        mutable.update { it.copy(consentAvailable = false) }
        return (consentRequestId ?: return null) to next
    }
    fun consentResult(resultRequestId: String?, approved: Boolean, message: String?) {
        val id = consentRequestId ?: return
        if (resultRequestId != id) return
        consentLaunched = false
        if (blocked || boundId != id || state.value.request?.active != true) { clearSensitive(); return }
        viewModelScope.launch {
            if (!approved) {
                consentRequestId = null
                mutable.update { it.copy(autofillDeclined = true) }
                return@launch
            }
            val codes = gate.approve(id, message.orEmpty())
            if (codes.isEmpty()) { fail(id, "code_extraction_failed"); return@launch }
            mutable.update { it.copy(candidates = codes, codeDraft = codes.singleOrNull() ?: it.codeDraft, autofillDeclined = false) }
            codes.singleOrNull()?.let { upload(id, approvedCode = it) }
        }
    }
    fun upload(requestId: String, approvedCode: String? = null) = action(waitForIdle = approvedCode != null) {
        val id = boundId ?: return@action
        val current = state.value
        val code = current.codeDraft.trim()
        if (blocked || id != requestId || current.request?.id != id || current.request.active != true || !CodeExtractor.validCode(code)) return@action
        if (approvedCode != null && (code != approvedCode || !gate.permits(id, approvedCode))) return@action
        val source = if (gate.permits(id, code)) "android_consent" else "manual"
        val response = try { retry(id) { repo.event(id, "completed", code = code, source = source) } }
            catch (e: IOException) { if (blocked) return@action else throw e }
        if (response.getString("status") != "completed") error("This request ended before the code could be shared.")
        applyRequest(PhoneRequest.from(response))
    }
    fun cancel() = viewModelScope.launch {
        val id = state.value.request?.id ?: return@launch
        if (state.value.cancelling) return@launch
        mutable.update { it.copy(cancelling = true, error = null) }
        blocked = true; clearSensitive(); unregisterReceiver()
        try { repo.event(id, "cancelled"); sync(id) }
        catch (e: CancellationException) { throw e }
        catch (_: IOException) { error("Could not confirm cancellation. Retry when connected; the request will also expire.") }
        finally { mutable.update { it.copy(cancelling = false) } }
    }
    fun consentUnavailable() { consentRequestId?.let { id -> viewModelScope.launch { fail(id, "consent_unavailable") } } }
    private suspend fun fail(id: String, reason: String) {
        clearSensitive(); unregisterReceiver(); blocked = true
        try { repo.event(id, "failed", reason); sync(id) }
        catch (_: IOException) { error("Could not report failure. The request will expire; reopen to retry.") }
    }
    private fun clearSensitive() {
        listenerWindow?.close(); listenerWindow = null
        gate.clear(); consent = null; consentRequestId = null; consentLaunched = false
        mutable.update { it.copy(candidates = emptyList(), codeDraft = "", autofillDeclined = false, consentAvailable = false, now = System.currentTimeMillis()) }
    }
    private fun unregisterReceiver() { receiver?.let { app.unregisterReceiver(it) }; receiver = null }
    private fun clearLocal() { poll?.cancel(); blocked = true; clearSensitive(); unregisterReceiver(); boundId = null; mutable.update { it.copy(request = null, discoveredRequest = null) } }
    override fun onCleared() { unregisterReceiver(); clearSensitive(); super.onCleared() }
}
