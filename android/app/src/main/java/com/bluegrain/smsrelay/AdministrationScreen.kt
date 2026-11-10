package com.bluegrain.smsrelay

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.util.Date

enum class AdministrationSection(val title: String) { Access("Access"), Devices("Devices"), History("History") }

@Composable
private fun AdministrationGroup(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
}
@Composable
fun AdministrationScreen(
    state: RelayUiState, section: AdministrationSection,
    onSection: (AdministrationSection) -> Unit = {}, onClose: () -> Unit = {},
    refreshing: Boolean = false, onSignIn: () -> Unit = {}, onRegister: () -> Unit = {}, onRefresh: () -> Unit = {},
    onRevoke: (String) -> Unit = {}, onDelete: () -> Unit = {},
    onPauseDevice: (String) -> Unit = {}, onRemoveDevice: (String) -> Unit = {},
    onApproveForms: (String, Boolean) -> Unit = { _, _ -> },
    onReviewConnection: (String) -> Unit = {}, onConnectionDecision: (String, Boolean) -> Unit = { _, _ -> }, onDismissConnection: () -> Unit = {},
) {
    val uriHandler = LocalUriHandler.current
    var connectionCode by remember(state.connectionCode) { mutableStateOf(state.connectionCode.orEmpty()) }
    var deletion by remember { mutableStateOf<String?>(null) }
    BackHandler(onBack = onClose)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
            ScreenToolbar("Administration")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                AdministrationSection.entries.forEachIndexed { i, item ->
                    SegmentedButton(selected = section == item, onClick = { onSection(item) },
                        shape = SegmentedButtonDefaults.itemShape(i, 3)) { Text(item.title) }
                }
            }
            RefreshableList(refreshing, onRefresh, modifier = Modifier.testTag("administration-list"),
                spacing = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(16.dp)) {
                state.error?.let { message -> item {
                    Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(12.dp)) {
                        Text(message, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onErrorContainer)
                    }
                } }
                if (!state.configured) item {
                    AdministrationGroup {
                        Text("Service not configured", style = MaterialTheme.typography.titleMedium)
                        Text("Install a configured build to connect.")
                    }
                } else if (!state.signedIn) item {
                    AdministrationGroup {
                        Text("Sign in to manage apps and devices.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = onSignIn, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Continue with Google") }
                    }
                } else {
                    when (section) {
                        AdministrationSection.Access -> {
                            state.connection?.let { connection -> item {
                                ConnectionPanel(connection, state, onConnectionDecision, onDismissConnection)
                            } }
                            item { AdministrationGroup {
                                Text("Connect app", style = MaterialTheme.typography.titleMedium)
                                OutlinedTextField(value = connectionCode, onValueChange = { connectionCode = it.uppercase().take(32) },
                                    label = { Text("Connection code") }, placeholder = { Text("ABCDE-FG234") },
                                    singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth())
                                OutlinedButton(onClick = { onReviewConnection(connectionCode.trim()) },
                                    modifier = Modifier.fillMaxWidth(), enabled = !state.busy && Regex("^[A-HJ-NP-Z2-9]{10}$").matches(connectionCode.replace("-", "").replace(" ", ""))) { Text("Review connection") }
                            } }
                            item {
                                Text("Connected apps", style = MaterialTheme.typography.titleMedium)
                                if (state.grants.isEmpty()) Text("No connected apps.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            state.grants.forEach { grant -> item { AdministrationGroup {
                                Text(grant.name, style = MaterialTheme.typography.titleMedium)
                                AccessStatus(grant.revoked, grant.expiresAt, state.now)
                                if (!grant.revoked && grant.expiresAt > state.now) {
                                    Text(if (grant.formsApproved) "SMS and interactive requests allowed" else "SMS requests only", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    SwitchRow("Allow interactive requests", grant.formsApproved, !state.busy) { onApproveForms(grant.id, !grant.formsApproved) }
                                }
                                if (!grant.revoked && grant.expiresAt > state.now) TextButton(onClick = { onRevoke(grant.id) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Disconnect") }
                            } } }
                        }
                        AdministrationSection.Devices -> {
                            if (!state.registered) item { AdministrationGroup {
                                Text("Connect this phone", style = MaterialTheme.typography.titleMedium)
                                Text("Allow notifications to receive requests on this phone.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Button(onClick = onRegister, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Finish connecting") }
                            } }
                            if (state.devices.isEmpty()) item { Text("No connected devices.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            state.devices.forEach { device -> item { AdministrationGroup {
                                Text(device.name, style = MaterialTheme.typography.titleMedium)
                                Text((if (device.current) "This phone · " else "") + if (device.paused) "Paused" else "Receives requests", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                SwitchRow("Receive requests", !device.paused, !state.busy) { onPauseDevice(device.id) }
                                TextButton(onClick = { deletion = "device:" + device.id }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Remove", color = MaterialTheme.colorScheme.error) }
                            } } }
                            item { AdministrationGroup {
                                Text("Account", style = MaterialTheme.typography.titleMedium)
                                Text(state.email, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text("Deletion asks you to verify the same Google account first.", style = MaterialTheme.typography.bodySmall)
                                TextButton(onClick = onSignIn, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Sign in again") }
                                TextButton(onClick = { deletion = "account" }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
                                TextButton(onClick = { uriHandler.openUri(BuildConfig.RELAY_URL.trimEnd('/') + "/privacy") }, enabled = state.configured, modifier = Modifier.fillMaxWidth()) { Text("Privacy policy") }
                                TextButton(onClick = { uriHandler.openUri(BuildConfig.RELAY_URL.trimEnd('/') + "/account/delete") }, enabled = state.configured, modifier = Modifier.fillMaxWidth()) { Text("Delete account on the web") }
                            } }
                        }
                        AdministrationSection.History -> {
                            val outcomes = state.history.filterNot { it.status in setOf("queued", "pending_phone", "ready", "awaiting_consent", "pending") }
                            if (outcomes.isEmpty()) item { Text("No history yet.") }
                            outcomes.forEach { row -> item {
                                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(row.caller, fontWeight = FontWeight.Medium)
                                    Text(requestStatusLabel(row.status), color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    row.reason?.let { Text(it.replace('_', ' '), style = MaterialTheme.typography.bodySmall) }
                                }
                            } }
                        }
                    }
                }
            }
        }
    }
    deletion?.let { kind ->
        val device = kind.startsWith("device:")
        AlertDialog(onDismissRequest = { deletion = null }, title = { Text(if (device) "Remove this phone?" else "Delete your account?") },
            text = { Text(if (device) "This phone stops receiving requests. Your other phones and caller credentials remain available."
                else "Verify your Google account, then permanently remove all phones, app connections, callers, requests, and stored results. Access stops immediately when accepted; cleanup continues in the background.") },
            confirmButton = { TextButton(onClick = {
                deletion = null
                when { device -> onRemoveDevice(kind.substringAfter(':')); else -> onDelete() }
            }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deletion = null }) { Text("Keep") } })
    }
}
@Composable
private fun ConnectionPanel(c: ConnectionReview, state: RelayUiState, onDecision: (String, Boolean) -> Unit, onDismiss: () -> Unit) {
    AdministrationGroup {
        Text(c.caller, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(c.purpose, style = MaterialTheme.typography.bodyLarge)
        Text(c.code, fontFamily = FontFamily.Monospace, fontSize = 24.sp)
        val pending = c.status == "pending" && c.expiresAt > state.now
        if (pending) {
            Text("Connect to ${state.email}", style = MaterialTheme.typography.titleMedium)
            Text("May request upcoming SMS codes from your registered phones for ${c.days} days. Each message still needs Android’s consent.")
            Text("The app name is supplied by the requester. Approve only a connection you started, with the same code shown by your app or bot.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = { onDecision(c.code, true) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Approve connection") }
            OutlinedButton(onClick = { onDecision(c.code, false) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Decline connection") }
        } else Text(when (c.status) { "approved" -> "Connected."; "denied" -> "Connection declined"; "revoked" -> "Connection revoked. Ask the app for a new link."; else -> "Connection expired. Ask the app for a new link." },
            style = MaterialTheme.typography.titleMedium)
        TextButton(onClick = onDismiss, enabled = !state.busy) { Text(if (pending) "Close" else "Done") }
    }
}
@Composable
private fun AccessStatus(revoked: Boolean, expiresAt: Long, now: Long) {
    Text(if (revoked) "Revoked" else if (expiresAt <= now) "Expired" else "Expires ${DateFormat.getDateInstance().format(Date(expiresAt))}",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
