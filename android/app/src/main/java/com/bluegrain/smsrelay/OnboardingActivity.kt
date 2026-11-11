package com.bluegrain.smsrelay

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** A separate task keeps link approval independent of Inbox drafts and Administration navigation. */
class OnboardingActivity : AccountActivity() {
    override val administrationOnly = true
    private var destination by mutableStateOf<OnboardingLink?>(null)
    private var attempt by mutableStateOf(UUID.randomUUID().toString())
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        destination = ConnectionLinks.onboarding(savedInstanceState?.getString("destination") ?: intent.dataString.orEmpty(), BuildConfig.RELAY_URL)
        attempt = savedInstanceState?.getString("attempt") ?: UUID.randomUUID().toString()
        setContent {
            val account by vm.state.collectAsStateWithLifecycle()
            RelayTheme {
                val target = destination
                if (target == null) Surface(Modifier.fillMaxSize()) { Column(Modifier.safeDrawingPadding().padding(24.dp)) { Text("This relay link is not supported."); TextButton(onClick = ::finish) { Text("Close") } } }
                else OnboardingScreen(target, attempt, account, (application as RelayApplication).repository::onboarding,
                    onSignIn = ::signIn, onRegister = ::register, onClose = ::finish,
                    onRestart = { attempt = UUID.randomUUID().toString() }, onManage = { id -> destination = OnboardingLink("connections", id); attempt = UUID.randomUUID().toString() })
            }
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val target = ConnectionLinks.onboarding(intent.dataString.orEmpty(), BuildConfig.RELAY_URL) ?: return
        setIntent(intent); destination = target; attempt = UUID.randomUUID().toString()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        destination?.let { outState.putString("destination", BuildConfig.RELAY_URL.trimEnd('/') + "/${if (it.kind == "oauth") "oauth/consent" else it.kind}/${it.id}") }
        outState.putString("attempt", attempt); super.onSaveInstanceState(outState)
    }
}

@Composable
internal fun OnboardingScreen(target: OnboardingLink, attempt: String, account: RelayUiState,
    request: suspend (String, String, JSONObject?) -> JSONObject,
    onSignIn: () -> Unit, onRegister: () -> Unit, onClose: () -> Unit, onRestart: () -> Unit, onManage: (String) -> Unit) {
    var sessionText by rememberSaveable(target, attempt) { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var statusText by remember { mutableStateOf("") }
    var needsPhone by remember { mutableStateOf(false) }
    var self by rememberSaveable(target, attempt) { mutableStateOf(false) }
    var forms by rememberSaveable(target, attempt) { mutableStateOf(true) }
    var sms by rememberSaveable(target, attempt) { mutableStateOf(true) }
    var duration by rememberSaveable(target, attempt) { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()
    val oauth = target.kind == "oauth"
    val registration = target.kind == "register"
    val management = target.kind == "connections"
    val session = sessionText?.let(::JSONObject)
    val pending = session?.optString("status") == "pending"
    val caps = session?.optJSONArray(if (management) "availableCapabilities" else "capabilities")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
    LaunchedEffect(account.signedIn, target, attempt, retry) {
        if (!account.signedIn) return@LaunchedEffect
        busy = true; error = null
        try {
            val reviewed = if (management) {
                request("GET", "/v3/connections/${target.id}", null).also { current ->
                    current.put("sessionId", target.id).put("status", if (current.optBoolean("revoked")) "denied" else "pending")
                    forms = current.getJSONArray("capabilities").toString().contains("forms")
                    sms = current.getJSONArray("capabilities").toString().contains("sms")
                    duration = if (current.isNull("expiresAt")) null else kotlin.math.max(1, ((current.getLong("expiresAt") - System.currentTimeMillis() + 86_399_999) / 86_400_000).toInt())
                }
            } else if (oauth) {
                request("GET", "/v3/oauth/sessions/${target.id}", null)
            } else if (target.kind == "services") {
                val service = request("GET", "/v3/services/${target.id}", null)
                request("POST", "/v3/services/${target.id}/connections", JSONObject().put("capabilities", service.getJSONArray("capabilities")).put("expiresInDays", JSONObject.NULL).put("idempotencyKey", attempt))
            } else request("GET", "/v3/${if (registration) "registration" else "pairing"}-sessions/${target.id}", null)
            sessionText = reviewed.toString()
            if (reviewed.has("expiresInDays") && !reviewed.isNull("expiresInDays") && duration == null) duration = reviewed.getInt("expiresInDays")
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = onboardingError(e) }
        finally { busy = false }
    }
    LaunchedEffect(sessionText, retry) {
        val approved = sessionText?.let(::JSONObject) ?: return@LaunchedEffect
        if (approved.optString("status") != "approved") return@LaunchedEffect
        if (registration && approved.isNull("connectionId")) { statusText = "Service registered. Return to the CLI to finish setup. A receiving phone is not required."; return@LaunchedEffect }
        while (true) {
            try {
                val state = request("GET", "/v3/connections/${approved.getString("connectionId")}", null)
                needsPhone = state.optString("setup") == "phone_setup_needed"
                statusText = when (state.optString("setup")) {
                    "phone_setup_needed" -> "Access granted — connect a phone to receive requests"
                    "waiting_for_service" -> "Access granted. Waiting for service to store the connection…"
                    "setup_complete" -> "Setup complete. The service can request your approval."
                    else -> "This connection is disconnected."
                }
                if (state.optString("setup") in setOf("setup_complete", "disconnected")) break
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = onboardingError(e); break }
            delay(5_000)
        }
    }
    fun decide(approved: Boolean) {
        if (busy || session == null) return
        val chosen = caps.filter { (it == "forms" && forms) || (it == "sms" && sms) }
        if (approved && (!registration || self) && chosen.isEmpty()) { error = "Select at least one permission."; return }
        scope.launch {
            busy = true; error = null
            try {
                val body = JSONObject().put("decision", if (approved) "approved" else "denied")
                    .put("capabilities", JSONArray(chosen.ifEmpty { caps })).put("expiresInDays", duration ?: JSONObject.NULL)
                if (registration) body.put("selfAccess", approved && self)
                if (management) {
                    if (approved) {
                        val updated = request("PATCH", "/v3/connections/${target.id}", JSONObject().put("capabilities", JSONArray(chosen)).put("expiresAt", duration?.let { System.currentTimeMillis() + it * 86_400_000L } ?: JSONObject.NULL))
                        updated.put("sessionId", target.id).put("status", "pending"); sessionText = updated.toString(); statusText = "Permissions saved."
                    } else { request("DELETE", "/v3/connections/${target.id}", null); sessionText = session.put("status", "denied").toString() }
                } else if (oauth) {
                    request("POST", "/v3/oauth/sessions/${target.id}/decision", body)
                    sessionText = request("GET", "/v3/oauth/sessions/${target.id}", null).toString()
                } else sessionText = request("POST", "/v3/${if (registration) "registration" else "pairing"}-sessions/${session.getString("sessionId")}/decision", body).toString()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = onboardingError(e) }
            finally { busy = false }
        }
    }
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            TextButton(onClick = onClose) { Text("Close") }
            Text(if (registration) "Register service" else if (management) "Manage connection" else "Connect to service", style = MaterialTheme.typography.labelLarge)
            Text(session?.optString("name") ?: "Review access", style = MaterialTheme.typography.headlineLarge)
            session?.optString("purpose")?.let { Text(it) }
            if (!account.configured) Text("Configure this relay before signing in.")
            else if (!account.signedIn) { Text("Sign in to review this link. Opening it grants no access."); Button(onClick = onSignIn, enabled = !account.busy) { Text("Continue with Google") } }
            else {
                Text("Signed in as ${account.email}", style = MaterialTheme.typography.bodySmall)
                if (!registration && session != null) Text("The service name is supplied by its operator. Registration is not verification or endorsement.", style = MaterialTheme.typography.bodySmall)
                if (oauth && session != null) Text("Requested by ${session.optString("clientName")} (${session.optString("clientOrigin")}). These app details are supplied by the app operator.")
                session?.nullString("comparisonCode")?.let { Text("Compare code $it", style = MaterialTheme.typography.titleLarge) }
                if (pending) {
                    if (registration) { Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(self, enabled = !busy, role = Role.Switch, onValueChange = { self = it })) { Switch(checked = self, onCheckedChange = null, enabled = !busy); Spacer(Modifier.width(12.dp)); Text("Also allow this service to send requests to me") } }
                    if (!registration || self) {
                        Text("Allow requests for", style = MaterialTheme.typography.titleMedium)
                        if ("forms" in caps) Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(forms, enabled = !busy, role = Role.Checkbox, onValueChange = { forms = it })) { Checkbox(checked = forms, onCheckedChange = null, enabled = !busy); Text("Information and decisions through forms", Modifier.padding(top = 12.dp)) }
                        if ("sms" in caps) Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(sms, enabled = !busy, role = Role.Checkbox, onValueChange = { sms = it })) { Checkbox(checked = sms, onCheckedChange = null, enabled = !busy); Text("Upcoming SMS codes, shared with your approval", Modifier.padding(top = 12.dp)) }
                        Text("Access duration", style = MaterialTheme.typography.titleMedium)
                        val maximum = if (management || session!!.isNull("expiresInDays")) null else session.getInt("expiresInDays")
                        val durations = (listOf<Int?>(null, 1, 7, 30, 90) + listOfNotNull(maximum)).distinct().filter { maximum == null || (it != null && it <= maximum) }
                        Column(Modifier.selectableGroup()) {
                            durations.forEach { days -> Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(duration == days, enabled = !busy, role = Role.RadioButton, onClick = { duration = days })) { RadioButton(selected = duration == days, onClick = null, enabled = !busy); Text(if (days == null) "Until disconnected" else "$days days", Modifier.padding(top = 12.dp)) } }
                        }
                        Text("Every response still needs your approval.")
                    }
                    Button(onClick = { decide(true) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(if (registration) "Register service" else if (management) "Save permissions" else "Connect") }
                    TextButton(onClick = { decide(false) }, enabled = !busy) { Text(if (management) "Disconnect" else "Cancel") }
                if (management && statusText.isNotBlank()) Text(statusText)
                } else when (session?.optString("status")) {
                    "approved" -> { if (oauth) Text("Return to the requesting app to finish connecting."); if (!registration || !session!!.isNull("connectionId")) TextButton(onClick = { onManage(session!!.getString("connectionId")) }) { Text("Manage permissions") }; Text(statusText.ifBlank { "Access granted. Waiting for service…" }); if (needsPhone) { Text("Sign in and allow notifications to receive requests on this phone."); Button(onClick = onRegister, enabled = !account.busy) { Text("Connect this phone") } } }
                    "denied" -> Text(if (management) "Disconnected." else "Cancelled. No new access was granted.")
                    "expired" -> { Text("This session expired. Request a fresh link and approve access again."); if (target.kind == "services") Button(onClick = onRestart) { Text("Start a new connection") } }
                }
            }
            if (busy) CircularProgressIndicator()
            (error ?: account.error)?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = { retry++ }, enabled = !busy) { Text("Try again") } }
        }
    }
}
private fun onboardingError(e: Exception) = when ((e as? ApiFailure)?.reason) {
    "session_expired" -> "This session expired. Request a new link and approve access again."
    "service_unavailable" -> "This service is unavailable."
    else -> "Could not complete this step. Try again to check the current state."
}
