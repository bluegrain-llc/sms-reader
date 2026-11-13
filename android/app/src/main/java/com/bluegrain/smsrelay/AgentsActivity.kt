package com.bluegrain.smsrelay

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject

class AgentsActivity : AccountActivity() {
    override val administrationOnly = true
    private var message by mutableStateOf<String?>(null)
    private var exportOwner: String? = null
    private var exportCredential: String? = null
    private fun exportTicket(owner: String, credential: String) {
        check(exportOwner == null && exportCredential == null) { "export_pending" }
        check(owner.isNotBlank() && owner == repository.ownerId)
        AgentTicket(this, owner).loadForExport(credential)
        exportOwner = owner; exportCredential = credential
        try { export.launch("agent-session-ticket.json") }
        catch (e: Exception) { exportOwner = null; exportCredential = null; throw e }
    }
    private val repository get() = (application as RelayApplication).repository
    private val export = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val owner = exportOwner; val credential = exportCredential
        exportOwner = null; exportCredential = null
        if (uri != null) lifecycleScope.launch {
            try {
                check(owner != null && owner == repository.ownerId && credential != null)
                val ticket = AgentTicket(this@AgentsActivity, owner).loadForExport(credential)
                contentResolver.openFileDescriptor(uri, "wt")?.use { descriptor ->
                    java.io.FileOutputStream(descriptor.fileDescriptor).use { it.write(ticket.toString().toByteArray(Charsets.UTF_8)); it.flush() }
                } ?: error("document_unavailable")
                message = "Ticket saved. Supply it privately to your agent; connect separately to grant account access."
            } catch (_: Exception) { message = "Could not save the ticket. Your private provisioning state is retained; try saving again." }
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent {
            val account by vm.state.collectAsStateWithLifecycle()
            val scope = rememberCoroutineScope()
            var services by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
            var name by remember { mutableStateOf("") }; var purpose by remember { mutableStateOf("") }
            var forms by remember { mutableStateOf(true) }; var sms by remember { mutableStateOf(false) }
            var pending by remember(account.email) { mutableStateOf<JSONObject?>(null) }; var ticketLoaded by remember(account.email) { mutableStateOf(false) }; var busy by remember { mutableStateOf(false) }
            suspend fun refresh() { pending = AgentTicket(this@AgentsActivity, repository.ownerId).load(); ticketLoaded = true; services = repository.services().objects() }
            fun work(action: suspend () -> Unit) { if (!busy) scope.launch { busy = true; try { action() } catch (e: CancellationException) { throw e } catch (_: Exception) { message = "Could not complete this step. Retained ticket state is available for retry." } finally { busy = false } } }
            LaunchedEffect(account.signedIn, account.email) { if (account.signedIn) work { refresh() } }
            RelayTheme { Surface(Modifier.fillMaxSize()) { Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                TextButton(onClick = ::finish) { Text("Close") }; Text("Agents", style = MaterialTheme.typography.headlineLarge)
                if (!account.signedIn) Button(onClick = ::signIn) { Text("Sign in") }
                else {
                    Text("Create agent", style = MaterialTheme.typography.titleLarge)
                    Text("Save a private session ticket to give to your agent. Access to an account requires a separate connection approval.")
                    if (pending == null) {
                        OutlinedTextField(name, { name = it.take(80) }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(purpose, { purpose = it.take(240) }, label = { Text("Description") }, modifier = Modifier.fillMaxWidth())
                        SwitchRow("Forms and decisions", forms, !busy) { forms = !forms }; SwitchRow("SMS codes", sms, !busy) { sms = !sms }
                        Button(enabled = ticketLoaded && !busy && name.isNotBlank() && purpose.isNotBlank() && (forms || sms), onClick = { work {
                            val owner = repository.ownerId
                            val ticket = AgentTicket.create(name.trim(), purpose.trim(), listOfNotNull(if (forms) "forms" else null, if (sms) "sms" else null))
                            AgentTicket(this@AgentsActivity, owner).saveNew(ticket); pending = ticket
                            repository.onboarding("POST", "/v3/services", AgentTicket.declaration(ticket)); refresh(); exportTicket(owner, ticket.getString("serviceCredential"))
                        } }) { Text("Create agent and save ticket") }
                    } else {
                        Text("Retained ticket for ${pending!!.getJSONObject("agent").getString("name")}")
                        Button(enabled = !busy, onClick = {
                            val owner = repository.ownerId; val ticket = pending!!
                            work { repository.onboarding("POST", "/v3/services", AgentTicket.declaration(ticket)); refresh(); exportTicket(owner, ticket.getString("serviceCredential")) }
                        }) { Text("Save session ticket") }
                        var confirmClear by remember { mutableStateOf(false) }
                        TextButton(onClick = { confirmClear = true }) { Text("Clear retained ticket") }
                        if (confirmClear) AlertDialog(onDismissRequest = { confirmClear = false }, title = { Text("Ticket safely saved?") }, text = { Text("Clear only after saving the ticket or deleting the agent. The relay cannot recover private keys.") }, confirmButton = { TextButton(onClick = { val expectedCredential = pending!!.getString("serviceCredential"); confirmClear = false; work {
                            val storage = AgentTicket(this@AgentsActivity, repository.ownerId)
                            val cleared = storage.clear(expectedCredential); pending = storage.load()
                            if (!cleared) message = "The retained ticket changed. Review the current agent before clearing."
                        } }) { Text("Clear") } }, dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } })
                    }
                    Text("Your agents", style = MaterialTheme.typography.titleLarge)
                    services.forEach { service ->
                        Text(service.getString("name"), style = MaterialTheme.typography.titleMedium); Text(service.getString("purpose"))
                        TextButton(onClick = { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(BuildConfig.RELAY_URL.trimEnd('/') + service.getString("servicePath")))) }) { Text("Connect to agent") }
                        Button(enabled = !busy, onClick = { work { repository.onboarding("PATCH", "/v3/services/${service.getString("serviceId")}", JSONObject().put("active", !service.getBoolean("active"))); refresh() } }) { Text(if (service.getBoolean("active")) "Disable agent" else "Enable agent") }
                        var confirmDelete by remember(service.getString("serviceId")) { mutableStateOf(false) }
                        TextButton(onClick = { confirmDelete = true }) { Text("Delete agent") }
                        if (confirmDelete) AlertDialog(onDismissRequest = { confirmDelete = false }, title = { Text("Delete agent?") }, text = { Text("All its connections will lose access.") }, confirmButton = { TextButton(onClick = { confirmDelete = false; work { repository.onboarding("DELETE", "/v3/services/${service.getString("serviceId")}"); refresh() } }) { Text("Delete") } }, dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } })
                    }
                }
                message?.let { Text(it) }; if (busy) CircularProgressIndicator()
            } } }
        }
    }
    override fun onResume() { super.onResume(); vm.foreground(true) }
    override fun onStop() { vm.foreground(false); super.onStop() }
}
