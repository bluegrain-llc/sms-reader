package com.bluegrain.smsrelay

import android.app.Application
import android.content.*
import android.os.SystemClock
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
    val now: Long = System.currentTimeMillis(), val foreground: Boolean = false,
    val stepId: String? = null, val reviewing: Boolean = false, val fieldErrors: Map<String, String> = emptyMap(),
    val openingForms: Int = 0)
class InboxViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as RelayApplication
    private val repo get() = app.repository
    private val mutable = MutableStateFlow(InboxState())
    val state = mutable.asStateFlow()
    private var receiver: BroadcastReceiver? = null
    private var helperRequest: String? = null
    private var helperField: String? = null
    private var submitBody: JSONObject? = null
    private var listenerWindow: SmsListenerWindow? = null
    private data class Draft(val values: Map<String, Any>, val stepId: String?, val reviewing: Boolean, val submission: JSONObject?, val expiresAt: Long)
    private val drafts = mutableMapOf<String, Draft>()
    private fun saveDraft() {
        val s = state.value
        s.form?.takeIf { it.status == "pending" && s.now < it.expiresAt }?.let { drafts[it.id] = Draft(s.values, s.stepId, s.reviewing, submitBody, it.expiresAt) }
    }
    init {
        viewModelScope.launch {
            var tick = 0
            while (true) {
                delay(1_000)
                expireDraftsAndHelper()
                if (++tick % 5 == 0 && state.value.foreground && app.configured && repo.signedIn && repo.registered && !state.value.busy) refresh()
            }
        }
    }
    private fun listenerNow(wallNow: Long) = listenerWindow?.now(wallNow) ?: wallNow
    private fun expireDraftsAndHelper() {
        mutable.update { it.copy(now = listenerNow(System.currentTimeMillis())) }
        drafts.entries.removeAll { it.value.expiresAt <= state.value.now }
        state.value.let { s ->
            s.form?.takeIf { s.now >= it.expiresAt && (s.values.isNotEmpty() || s.stepId != null || s.reviewing ||
                s.fieldErrors.isNotEmpty() || submitBody != null || helperRequest == it.id) }?.let(::showLoaded)
        }
        if (listenerWindow?.expired() == true) stopHelper("SMS listening ended. You can still enter the code manually.")
    }
    fun foreground(value: Boolean) { mutable.update { it.copy(foreground = value) }; if (value) refresh() }
    private var sessionOwner: String? = null
    fun sessionChanged() {
        if (!app.configured) return
        if (sessionOwner != repo.ownerId) {
            stopHelper(null); submitBody = null; drafts.clear(); sessionOwner = repo.ownerId
            mutable.update { InboxState(foreground = it.foreground, openingForms = it.openingForms, now = listenerNow(System.currentTimeMillis())) }
        }
        refresh()
    }
    fun refresh() = viewModelScope.launch {
        if (!app.configured || !repo.signedIn || !repo.registered) return@launch
        val owner = repo.ownerId
        try {
            val requests = repo.inbox()
            if (owner != repo.ownerId) return@launch
            drafts.keys.retainAll(requests.map { it.id }.toSet())
            // A retained request may have disappeared; that must not prevent Inbox updates.
            mutable.update { it.copy(requests = requests) }
            val form = state.value.form?.takeIf { it.status == "pending" }?.let { current -> repo.form(current.id) }
            if (owner != repo.ownerId) return@launch
            mutable.update { it.copy(form = if (it.form?.id == form?.id && it.form?.status == "pending") form else it.form,
                values = if (form != null && it.form?.id == form.id && form.status != "pending") emptyMap() else it.values) }
            if (form != null && state.value.form?.id == form.id && form.status != "pending") { stopHelper(null); submitBody = null }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { /* explicit actions present errors; background refresh preserves drafts */ }
    }
    fun open(id: String) = viewModelScope.async {
        mutable.update { it.copy(openingForms = it.openingForms + 1) }
        try {
            var loaded = false
            performAction(waitForIdle = true) {
                val owner = repo.ownerId
                val form = repo.form(id)
                if (owner != repo.ownerId) return@performAction
                showLoaded(form)
                loaded = true
            }
            loaded
        } finally { mutable.update { it.copy(openingForms = it.openingForms - 1) } }
    }
    internal fun showLoaded(form: RequestForm) {
        saveDraft()
        if (state.value.form?.id != form.id || form.status != "pending" || state.value.now >= form.expiresAt) {
            stopHelper(null); helperField = null; mutable.update { it.copy(candidates = emptyList()) }
        }
        if (form.status != "pending" || state.value.now >= form.expiresAt) drafts.remove(form.id)
        val draft = drafts[form.id]
        submitBody = draft?.submission
        mutable.update { it.copy(form = form, values = draft?.values.orEmpty(), stepId = draft?.stepId,
            reviewing = draft?.reviewing ?: false, fieldErrors = emptyMap(), error = null) }
    }
    fun close() {
        val form = state.value.form
        if (form != null && state.value.now >= form.expiresAt) showLoaded(form) else saveDraft()
        refresh()
    }
    fun rendered(id: String) { if (state.value.foreground && state.value.form?.id == id) reportObservation(app, id, "request.opened") }
    fun change(id: String, value: Any) {
        if (state.value.busy || state.value.form?.status != "pending") return
        submitBody = null
        mutable.update { s ->
            val form = s.form ?: return@update s
            if (FormWizard.fields(form, s.values).none { it.id == id }) return@update s
            val values = FormWizard.prune(form, s.values + (id to value))
            s.copy(values = values, stepId = FormWizard.current(form, values, s.stepId)?.id, fieldErrors = s.fieldErrors - id, error = null)
        }
        val current = state.value
        if (helperField != null && current.form?.let { FormWizard.fields(it, current.values).none { field -> field.id == helperField } } == true) {
            stopHelper(null); helperField = null; mutable.update { it.copy(candidates = emptyList()) }
        }
    }
    fun next() {
        val s = state.value; val form = s.form ?: return
        if (s.busy || form.status != "pending" || s.now >= form.expiresAt || s.reviewing) return
        val steps = FormWizard.visibleSteps(form, s.values)
        val current = FormWizard.current(form, s.values, s.stepId) ?: return
        val errors = FormWizard.errors(FormWizard.stepFields(form, current), s.values)
        if (errors.isNotEmpty()) { mutable.update { it.copy(fieldErrors = errors, error = "Check the highlighted fields before continuing.") }; return }
        val next = steps.getOrNull(steps.indexOf(current) + 1)
        mutable.update { it.copy(stepId = next?.id ?: current.id, reviewing = next == null, fieldErrors = emptyMap(), error = null) }
    }
    fun previous() {
        val s = state.value; val form = s.form ?: return
        if (s.busy || form.steps.isEmpty()) return
        val steps = FormWizard.visibleSteps(form, s.values)
        val previous = if (s.reviewing) steps.lastOrNull() else steps.getOrNull(steps.indexOf(FormWizard.current(form, s.values, s.stepId)) - 1)
        if (previous == null) close() else mutable.update { it.copy(stepId = previous.id, reviewing = false, fieldErrors = emptyMap(), error = null) }
    }
    private fun action(waitForIdle: Boolean = false, block: suspend () -> Unit) = viewModelScope.launch { performAction(waitForIdle, block) }
    private suspend fun performAction(waitForIdle: Boolean = false, block: suspend () -> Unit) {
        if (waitForIdle) while (state.value.busy) delay(50)
        if (state.value.busy) return
        mutable.update { it.copy(busy = true, error = null) }
        try { block() } catch (e: CancellationException) { throw e }
        catch (e: ApiFailure) { mutable.update { it.copy(error = e.reason.replace('_', ' ')) } }
        catch (_: Exception) { mutable.update { it.copy(error = "Could not connect. Your response is here; try again when connected.") } }
        finally { mutable.update { it.copy(busy = false) } }
    }
    fun submit(selectedAction: FormAction) = action {
        val s = state.value; val form = s.form ?: return@action
        if (form.status != "pending") return@action
        if (form.steps.isNotEmpty() && selectedAction.type != "decline") {
            if (!s.reviewing) return@action
            val errors = FormWizard.errors(FormWizard.fields(form, s.values), s.values)
            if (errors.isNotEmpty()) {
                val step = FormWizard.visibleSteps(form, s.values).first { step -> step.fieldIds.any { it in errors } }
                mutable.update { it.copy(stepId = step.id, reviewing = false, fieldErrors = errors, error = "Check the highlighted fields.") }; return@action
            }
        }
        val values = JSONObject()
        if (selectedAction.type != "decline") for (field in FormWizard.fields(form, s.values)) s.values[field.id]?.let { value ->
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
        if (result.status != "pending") { stopHelper(null); drafts.remove(form.id); submitBody = null }
        refresh()
    }
    fun listen(field: FormField) = action {
        val form = state.value.form ?: return@action
        if (!field.sms || form.status != "pending") return@action
        if (repo.deviceId in form.helperDevices) throw ApiFailure("input_already_started_use_manual_entry", 409)
        if (repo.listenerUntil > System.currentTimeMillis()) throw ApiFailure("sms_listener_busy", 409)
        stopHelper(null)
        helperRequest = form.id; helperField = field.id
        val started = System.currentTimeMillis()
        val window = SmsListenerWindow(SystemClock.elapsedRealtime(), form.expiresAt - started, started, SystemClock::elapsedRealtime)
        listenerWindow = window
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION || helperRequest != form.id) return
                val status = IntentCompat.getParcelableExtra(intent, SmsRetriever.EXTRA_STATUS, Status::class.java) ?: return
                onListenerStatus(form.id, window, status.statusCode,
                    IntentCompat.getParcelableExtra(intent, SmsRetriever.EXTRA_CONSENT_INTENT, Intent::class.java))
            }
        }
        ContextCompat.registerReceiver(app, receiver, IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION), SmsRetriever.SEND_PERMISSION, null, ContextCompat.RECEIVER_EXPORTED)
        try {
            repo.listenerUntil = started + 5 * 60_000
            SmsRetriever.getClient(app).startSmsUserConsent(null).await()
            if (listenerWindow !== window || helperRequest != form.id) return@action
            val report = repo.formObservation(form.id, JSONObject().put("type", "input.ready").put("fieldId", field.id).put("listenerStartedAt", started))
            if (listenerWindow !== window || helperRequest != form.id) return@action
            if (report.getString("status") != "pending") { stopHelper(null); refresh(); return@action }
            window.ready.complete(true)
            mutable.update { it.copy(form = it.form?.copy(helperDevices = form.helperDevices + repo.deviceId), helper = "Listening for an upcoming SMS. Android will ask before sharing it.", helperUntil = started + 5 * 60_000) }
        } catch (e: Exception) { if (listenerWindow === window) stopHelper("SMS listening could not start. Enter the code manually."); throw e }
    }
    private fun onListenerStatus(id: String, window: SmsListenerWindow, status: Int, consent: Intent?) = viewModelScope.launch {
        if (!window.accepts(status == CommonStatusCodes.TIMEOUT) {
                listenerWindow === window && helperRequest == id && state.value.form?.let { it.id == id && it.status == "pending" } == true
            }) return@launch
        when (status) {
            CommonStatusCodes.SUCCESS -> if (consent == null) stopHelper("SMS approval unavailable. Enter the code manually.")
                else mutable.update { it.copy(consent = consent) }
            CommonStatusCodes.TIMEOUT -> stopHelper("SMS listening ended. Enter the code manually.")
        }
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
        listenerWindow?.close(); listenerWindow = null
        receiver?.let { app.unregisterReceiver(it) }; receiver = null; helperRequest = null
        mutable.update { it.copy(helper = message, helperUntil = 0, consent = null, now = System.currentTimeMillis()) }
    }
    override fun onCleared() { stopHelper(null); super.onCleared() }
}
