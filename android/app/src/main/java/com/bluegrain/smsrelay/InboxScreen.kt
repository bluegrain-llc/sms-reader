package com.bluegrain.smsrelay

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Date

@Composable
fun ScreenToolbar(title: String, onBack: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) TextButton(onClick = onBack) { Text("Back") }
        Text(title, Modifier.weight(1f).padding(vertical = 12.dp), style = MaterialTheme.typography.titleLarge)
        actions()
    }
}

@Composable
fun SwitchRow(label: String, checked: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = { onToggle() }),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

@Composable
fun InboxScreen(state: RelayUiState, forms: List<RequestForm>, onSettings: () -> Unit, onRefresh: () -> Unit,
    onOpenSms: (String) -> Unit, onOpenForm: (String) -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            ScreenToolbar("Inbox", actions = {
                TextButton(onClick = onRefresh, enabled = !state.busy) { Text("Refresh") }
                TextButton(onClick = onSettings) { Text("Settings") }
            })
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            LazyColumn(Modifier.fillMaxSize().testTag("inbox-list")) {
                state.error?.let { item { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) } }
                if (!state.configured || !state.signedIn || !state.registered) item {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(if (!state.configured) "Pilot setup needed" else if (!state.signedIn) "Sign in to receive requests" else "Connect this phone",
                            style = MaterialTheme.typography.titleMedium)
                        Text("Open Settings to finish connecting this phone.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = onSettings, modifier = Modifier.fillMaxWidth()) { Text("Open Settings") }
                    }
                }
                val sms = state.request?.takeIf { it.active && (it.listeningDeadline ?: it.expiresAt) > state.now }
                sms?.let { request -> item(key = "sms:${request.id}") {
                    InboxRow("sms:${request.id}", request.caller, request.title,
                        "SMS · ${requestStatusLabel(request.status)}", request.listeningDeadline ?: request.expiresAt) { onOpenSms(request.id) }
                } }
                val pending = forms.filter { it.status == "pending" && it.expiresAt > state.now }
                pending.forEach { form -> item(key = "form:${form.id}") {
                    InboxRow("form:${form.id}", form.caller, form.title, "Form · Waiting for your response", form.expiresAt) { onOpenForm(form.id) }
                } }
                if (sms == null && pending.isEmpty()) item {
                    Text("No pending requests.", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun InboxRow(tag: String, caller: String, title: String, status: String, expiresAt: Long, onOpen: () -> Unit) {
    Column(Modifier.fillMaxWidth().testTag(tag).clickable(role = Role.Button, onClick = onOpen)
        .padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(caller, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(status, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("Expires ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(expiresAt))}",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun ResponseEntryScreen(state: RelayUiState, loading: Boolean, onClose: () -> Unit, onSignIn: () -> Unit,
    onRegister: () -> Unit, onRetry: () -> Unit) {
    BackHandler(onBack = onClose)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            TextButton(onClick = onClose) { Text("Close") }
            Text("Request response", style = MaterialTheme.typography.titleLarge)
            when {
                !state.configured -> Text("This build has no service connection. Ask the operator for a configured APK.")
                !state.signedIn -> {
                    Text("Sign in to open this request.")
                    Button(onClick = onSignIn, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Continue with Google") }
                }
                !state.registered -> {
                    Text("Connect this phone to open this request.")
                    Button(onClick = onRegister, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Finish connecting") }
                }
                loading -> { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("Opening this request…") }
                else -> {
                    Text("Could not open this request.")
                    Button(onClick = onRetry, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Retry") }
                }
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}
