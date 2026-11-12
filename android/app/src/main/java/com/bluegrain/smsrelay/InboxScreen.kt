package com.bluegrain.smsrelay

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
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
fun InboxScreen(state: RelayUiState, forms: List<RequestForm>, onAdministration: () -> Unit, onRefresh: () -> Unit,
    onOpenSms: (String) -> Unit, onOpenForm: (String) -> Unit, refreshing: Boolean = false, openingTarget: RequestTarget? = null) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            ScreenToolbar("Inbox")
            RefreshableList(refreshing, onRefresh, modifier = Modifier.testTag("inbox-list")) {
                state.error?.let { item { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) } }
                if (!state.configured || !state.signedIn || !state.registered) item {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(if (!state.configured) "Service not configured" else if (!state.signedIn) "Sign in to receive requests" else "Connect this phone",
                            style = MaterialTheme.typography.titleMedium)
                        Button(onClick = onAdministration, modifier = Modifier.fillMaxWidth()) { Text("Open Administration") }
                    }
                }
                val sms = state.pendingSms?.takeIf { (it.listeningDeadline ?: it.expiresAt) > state.now }
                sms?.let { request -> item(key = "sms:${request.id}") {
                    InboxRow("sms:${request.id}", request.caller, request.title,
                        "SMS · ${requestStatusLabel(request.status)}", request.listeningDeadline ?: request.expiresAt,
                        openingTarget == RequestTarget(request.id, RequestKind.Sms)) { onOpenSms(request.id) }
                } }
                val pending = forms.filter { it.status == "pending" && it.expiresAt > state.now }
                pending.forEach { form -> item(key = "form:${form.id}") {
                    InboxRow("form:${form.id}", form.caller, form.title, "Form", form.expiresAt,
                        openingTarget == RequestTarget(form.id, RequestKind.Form)) { onOpenForm(form.id) }
                } }
                if (state.configured && state.signedIn && state.registered && sms == null && pending.isEmpty()) item {
                    Text("All caught up", Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 48.dp),
                        style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun InboxRow(tag: String, caller: String, title: String, status: String, expiresAt: Long, opening: Boolean, onOpen: () -> Unit) {
    Column(Modifier.fillMaxWidth().testTag(tag).clickable(enabled = !opening, role = Role.Button, onClick = onOpen)
        .padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(caller, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        Text(title, style = MaterialTheme.typography.titleMedium)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (opening) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Text(if (opening) "Opening…" else status, style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
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
                    Button(onClick = onSignIn, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Continue with Google or Apple") }
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
