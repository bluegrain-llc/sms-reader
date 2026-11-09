package com.bluegrain.smsrelay

import android.app.Application
import android.content.*
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.tasks.await
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

// No form answers in saved state, preferences, logs, or background work payloads.
data class InboxState(val requests: List<RequestForm> = emptyList(), val form: RequestForm? = null,
    val values: Map<String, Any> = emptyMap(), val busy: Boolean = false, val error: String? = null,
    val helper: String? = null, val helperUntil: Long = 0, val consent: Intent? = null, val candidates: List<String> = emptyList(),
    val now: Long = System.currentTimeMillis(), val foreground: Boolean = false)
class InboxViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as RelayApplication
    private val repo get() = app.repository
    private val mutable = MutableStateFlow(InboxState())
    val state = mutable.asStateFlow()
    private var receiver: BroadcastReceiver? = null
    private var helperRequest: String? = null
    private var helperField: String? = null
    private var submitBody: JSONObject? = null
    private var ready = CompletableDeferred<Boolean>()
    init {
        viewModelScope.launch {
            var tick = 0
            while (true) {
                delay(1_000)
                mutable.update { it.copy(now = System.currentTimeMillis()) }
                if (state.value.helperUntil in 1..System.currentTimeMillis()) stopHelper("SMS listening ended. You can still enter the code manually.")
                if (++tick % 5 == 0 && state.value.foreground && app.configured && repo.signedIn && repo.registered && !state.value.busy) refresh()
            }
        }
    }
    fun foreground(value: Boolean) { mutable.update { it.copy(foreground = value) }; if (value) refresh() }
    private var sessionOwner: String? = null
    fun sessionChanged() {
        if (!app.configured) return
        if (sessionOwner != repo.ownerId) {
            stopHelper(null); submitBody = null; sessionOwner = repo.ownerId
            mutable.update { InboxState(foreground = it.foreground) }
        }
        refresh()
    }
    fun refresh() = viewModelScope.launch {
        if (!app.configured || !repo.signedIn || !repo.registered) return@launch
        val owner = repo.ownerId
        try {
            val requests = repo.inbox()
            val form = state.value.form?.let { current -> repo.form(current.id) }
            if (owner != repo.ownerId) return@launch
            mutable.update { it.copy(requests = requests, form = if (it.form?.id == form?.id) form else it.form) }
            if (form != null && state.value.form?.id == form.id && form.status != "pending") stopHelper(null)
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { /* explicit actions present errors; background refresh preserves drafts */ }
    }
    fun open(id: String) = action {
        val owner = repo.ownerId
        val form = repo.form(id)
        if (owner != repo.ownerId) return@action
        if (state.value.form?.id != id) { stopHelper(null); submitBody = null; helperField = null; mutable.update { it.copy(candidates = emptyList()) } }
        mutable.update { it.copy(form = form, values = if (it.form?.id == id) it.values else emptyMap(), error = null) }
    }
    fun close() { if (state.value.busy) return; stopHelper(null); submitBody = null; mutable.update { it.copy(form = null, values = emptyMap(), error = null) }; refresh() }
    fun rendered(id: String) { if (state.value.foreground && state.value.form?.id == id) reportObservation(app, id, "request.opened") }
    fun change(id: String, value: Any) {
        if (state.value.busy || state.value.form?.status != "pending") return
        submitBody = null
        mutable.update { it.copy(values = it.values + (id to value), error = null) }
    }
    private fun action(block: suspend () -> Unit) = viewModelScope.launch {
        if (state.value.busy) return@launch
        mutable.update { it.copy(busy = true, error = null) }
        try { block() } catch (e: CancellationException) { throw e }
        catch (e: ApiFailure) { mutable.update { it.copy(error = e.reason.replace('_', ' ')) } }
        catch (_: Exception) { mutable.update { it.copy(error = "Could not connect. Your response is here; try again when connected.") } }
        finally { mutable.update { it.copy(busy = false) } }
    }
    fun submit(selectedAction: FormAction) = action {
        val s = state.value; val form = s.form ?: return@action
        if (form.status != "pending") return@action
        val values = JSONObject()
        if (selectedAction.type != "decline") for (field in form.fields) s.values[field.id]?.let { value ->
            if (field.type == "number" && value == "") return@let
            values.put(field.id, when {
                field.type == "number" -> (value as? String)?.toDoubleOrNull()?.takeIf { it.isFinite() } ?: throw ApiFailure("invalid_number", 400)
                value is Set<*> -> JSONArray(value.toList())
                else -> value
            })
        }
        val old = submitBody
        val body = if (old != null && old.optString("action") == selectedAction.id && old.getJSONObject("values").toString() == values.toString()) old
            else JSONObject().put("submissionId", UUID.randomUUID().toString()).put("action", selectedAction.id).put("values", values).also { submitBody = it }
        val result = repo.submitForm(form.id, body)
        mutable.update { it.copy(form = result, values = if (result.status == "pending") it.values else emptyMap()) }
        if (result.status != "pending") stopHelper(null)
        refresh()
    }
    fun listen(field: FormField) = action {
        val form = state.value.form ?: return@action
        if (!field.sms || form.status != "pending") return@action
        if (repo.deviceId in form.helperDevices) throw ApiFailure("input_already_started_use_manual_entry", 409)
        if (repo.listenerUntil > System.currentTimeMillis()) throw ApiFailure("sms_listener_busy", 409)
        stopHelper(null)
        helperRequest = form.id; helperField = field.id; ready = CompletableDeferred()
        val barrier = ready
        val started = System.currentTimeMillis()
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION || helperRequest != form.id) return
                val status = IntentCompat.getParcelableExtra(intent, SmsRetriever.EXTRA_STATUS, Status::class.java) ?: return
                viewModelScope.launch {
                    if (!barrier.await() || helperRequest != form.id) return@launch
                    if (status.statusCode == CommonStatusCodes.SUCCESS) {
                        val consent = IntentCompat.getParcelableExtra(intent, SmsRetriever.EXTRA_CONSENT_INTENT, Intent::class.java)
                        if (consent == null) stopHelper("SMS approval unavailable. Enter the code manually.")
                        else mutable.update { it.copy(consent = consent) }
                    } else if (status.statusCode == CommonStatusCodes.TIMEOUT) stopHelper("SMS listening ended. Enter the code manually.")
                }
            }
        }
        ContextCompat.registerReceiver(app, receiver, IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION), SmsRetriever.SEND_PERMISSION, null, ContextCompat.RECEIVER_EXPORTED)
        try {
            repo.listenerUntil = started + 5 * 60_000
            SmsRetriever.getClient(app).startSmsUserConsent(null).await()
            val report = repo.formObservation(form.id, JSONObject().put("type", "input.ready").put("fieldId", field.id).put("listenerStartedAt", started))
            if (report.getString("status") != "pending") { stopHelper(null); refresh(); return@action }
            ready.complete(true)
            mutable.update { it.copy(form = it.form?.copy(helperDevices = form.helperDevices + repo.deviceId), helper = "Listening for an upcoming SMS. Android will ask before sharing it.", helperUntil = started + 5 * 60_000) }
        } catch (e: Exception) { stopHelper("SMS listening could not start. Enter the code manually."); throw e }
    }
    fun takeConsent(): Pair<String, Intent>? {
        if (!state.value.foreground) return null
        val intent = state.value.consent ?: return null
        mutable.update { it.copy(consent = null) }
        return (helperRequest ?: return null) to intent
    }
    fun consentResult(id: String?, approved: Boolean, message: String?) {
        if (id != helperRequest || state.value.form?.id != id || state.value.form?.status != "pending") return
        if (!approved) { stopHelper("SMS autofill declined. You can enter the code manually."); return }
        val candidates = CodeExtractor.candidates(message.orEmpty())
        val field = helperField ?: return
        if (candidates.size == 1) change(field, candidates.single())
        mutable.update { it.copy(candidates = if (candidates.size > 1) candidates else emptyList()) }
        stopHelper(if (candidates.isEmpty()) "No code found. Enter it manually." else "Code filled. Review your response and submit when ready.")
    }
    fun candidate(code: String) { helperField?.let { change(it, code) }; mutable.update { it.copy(candidates = emptyList()) } }
    private fun stopHelper(message: String?) {
        if (!ready.isCompleted) ready.complete(false)
        receiver?.let { app.unregisterReceiver(it) }; receiver = null; helperRequest = null
        mutable.update { it.copy(helper = message, helperUntil = 0, consent = null) }
    }
    override fun onCleared() { stopHelper(null); super.onCleared() }
}
