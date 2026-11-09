package com.bluegrain.smsrelay

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.util.Date

private val Paper = Color(0xFFF5F8F7)
private val Signal = Color(0xFF006B5E)
private val Graphite = Color(0xFF142D29)
@Composable
fun RelayTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme(
        primary = Color(0xFF8AD6C3), onPrimary = Color(0xFF00382E),
        background = Color(0xFF0E1916), surface = Color(0xFF172621), surfaceVariant = Color(0xFF263A32),
        onBackground = Color(0xFFE4EEE9), onSurface = Color(0xFFE4EEE9), onSurfaceVariant = Color(0xFFAFCCC0),
        secondary = Color(0xFFAFCCC0), secondaryContainer = Color(0xFF263F35), onSecondaryContainer = Color(0xFFD4EAE2),
        outline = Color(0xFF78968A), outlineVariant = Color(0xFF3A5147),
    ) else lightColorScheme(primary = Signal, onPrimary = Color.White,
        background = Paper, surface = Color.White, surfaceVariant = Color(0xFFE5EEEA),
        onBackground = Graphite, onSurface = Graphite, onSurfaceVariant = Color(0xFF4B625D), error = Color(0xFFAC3228),
        secondary = Signal, secondaryContainer = Color(0xFFD4EAE2), onSecondaryContainer = Graphite,
        outline = Color(0xFF7B948B), outlineVariant = Color(0xFFCFDDD6))
    MaterialTheme(colorScheme = colors, content = content)
}
internal fun requestStatusLabel(status: String) = when (status) {
    "queued" -> "Waiting for another request"
    "pending_phone" -> "Opening listener"
    "ready" -> "Listening for your SMS"
    "awaiting_consent" -> "Review Android’s consent dialog"
    "completed" -> "Approved code shared"
    "denied" -> "Sharing declined"
    "cancelled" -> "Request cancelled"
    "expired" -> "Request expired"
    "failed" -> "Request could not finish"
    else -> status.replace('_', ' ')
}
@Composable
private fun SettingsGroup(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
}
@Composable
fun SettingsScreen(
    state: RelayUiState, section: SettingsSection,
    onSection: (SettingsSection) -> Unit = {}, onBack: () -> Unit = {},
    onSignIn: () -> Unit = {}, onRegister: () -> Unit = {}, onRefresh: () -> Unit = {},
    onRevoke: (String) -> Unit = {}, onDelete: () -> Unit = {},
    onPauseDevice: (String) -> Unit = {}, onRemoveDevice: (String) -> Unit = {},
    onApproveForms: (String, Boolean) -> Unit = { _, _ -> },
    onReviewConnection: (String) -> Unit = {}, onConnectionDecision: (String, Boolean) -> Unit = { _, _ -> }, onDismissConnection: () -> Unit = {},
) {
    var connectionCode by remember(state.connectionCode) { mutableStateOf(state.connectionCode.orEmpty()) }
    var deletion by remember { mutableStateOf<String?>(null) }
    BackHandler(onBack = onBack)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
            ScreenToolbar("Settings", onBack = onBack)
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                SettingsSection.entries.forEachIndexed { i, item ->
                    SegmentedButton(selected = section == item, onClick = { onSection(item) },
                        shape = SegmentedButtonDefaults.itemShape(i, 3)) { Text(item.title) }
                }
            }
            LazyColumn(Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(12.dp)) {
                if (state.busy) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                state.error?.let { message -> item {
                    Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(12.dp)) {
                        Text(message, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onErrorContainer)
                    }
                } }
                if (!state.configured) item {
                    SettingsGroup {
                        Text("Pilot setup needed", style = MaterialTheme.typography.titleLarge)
                        Text("This build has no service connection yet. Ask the operator for a configured pilot APK.")
                    }
                } else if (!state.signedIn) item {
                    SettingsGroup {
                        Text("One code, only with permission", style = MaterialTheme.typography.titleLarge)
                        Text("Sign in and allow notifications to connect this phone. Android asks before sharing an incoming SMS; only the approved code reaches the caller.")
                        Text("The app cannot read your inbox or retrieve old messages.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(onClick = onSignIn, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Continue with Google") }
                    }
                } else {
                    when (section) {
                        SettingsSection.Access -> {
                            state.connection?.let { connection -> item {
                                ConnectionPanel(connection, state, onConnectionDecision, onDismissConnection)
                            } }
                            item { SettingsGroup {
                                Text("Connect an app or bot", style = MaterialTheme.typography.titleLarge)
                                Text("Open the connection link your app or bot shows. Review it here and approve once. Its credential is delivered automatically.")
                                OutlinedTextField(value = connectionCode, onValueChange = { connectionCode = it.uppercase().take(32) },
                                    label = { Text("Connection code (if needed)") }, placeholder = { Text("ABCDE-FG234") },
                                    singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth())
                                OutlinedButton(onClick = { onReviewConnection(connectionCode.trim()) },
                                    modifier = Modifier.fillMaxWidth(), enabled = !state.busy && Regex("^[A-HJ-NP-Z2-9]{10}$").matches(connectionCode.replace("-", "").replace(" ", ""))) { Text("Review connection") }
                            } }
                            item {
                                Text("Connected apps and bots", style = MaterialTheme.typography.titleLarge)
                                if (state.grants.isEmpty()) Text("Your approved connections appear here. Each app gets its own credential.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            state.grants.forEach { grant -> item { SettingsGroup {
                                Text(grant.name, style = MaterialTheme.typography.titleMedium)
                                AccessStatus(grant.revoked, grant.expiresAt, state.now)
                                if (!grant.revoked && grant.expiresAt > state.now) {
                                    Text(if (grant.formsApproved) "SMS and interactive requests allowed" else "SMS requests only", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    SwitchRow("Allow interactive requests", grant.formsApproved, !state.busy) { onApproveForms(grant.id, !grant.formsApproved) }
                                }
                                if (!grant.revoked && grant.expiresAt > state.now) TextButton(onClick = { onRevoke(grant.id) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Revoke caller") }
                            } } }
                        }
                        SettingsSection.Devices -> {
                            if (!state.registered) item { SettingsGroup {
                                Text("Connect this phone", style = MaterialTheme.typography.titleMedium)
                                Text("Allow notifications to receive requests on this phone.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Button(onClick = onRegister, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Finish connecting") }
                            } }
                            item {
                                Text("Your phones", style = MaterialTheme.typography.titleLarge)
                                Text("Sign in with the same Google account on another phone to add it. Requests notify every available phone.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            state.devices.forEach { device -> item { SettingsGroup {
                                Text(device.name, style = MaterialTheme.typography.titleMedium)
                                Text((if (device.current) "This phone · " else "") + if (device.paused) "Paused" else "Receives requests", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                SwitchRow("Receive requests", !device.paused, !state.busy) { onPauseDevice(device.id) }
                                TextButton(onClick = { deletion = "device:" + device.id }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Remove", color = MaterialTheme.colorScheme.error) }
                            } } }
                            item { SettingsGroup {
                                Text("Account", style = MaterialTheme.typography.titleMedium)
                                Text(state.email, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text("Sign in again before deleting your account.", style = MaterialTheme.typography.bodySmall)
                                TextButton(onClick = onSignIn, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Sign in again") }
                                TextButton(onClick = { deletion = "account" }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
                            } }
                        }
                        SettingsSection.History -> {
                            item {
                                Text("Recent outcomes", style = MaterialTheme.typography.titleLarge)
                                Text("Seven days of requests across your phones. Codes and messages never appear here.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            val outcomes = state.history.filterNot { it.status in setOf("queued", "pending_phone", "ready", "awaiting_consent", "pending") }
                            if (outcomes.isEmpty()) item { Text("No outcomes yet.") }
                            outcomes.forEach { row -> item {
                                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(row.caller, fontWeight = FontWeight.Medium)
                                    Text(requestStatusLabel(row.status), color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    row.reason?.let { Text(it.replace('_', ' '), style = MaterialTheme.typography.bodySmall) }
                                }
                            } }
                        }
                    }
                    item { TextButton(onClick = onRefresh, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Refresh settings") } }
                }
            }
        }
    }
    deletion?.let { kind ->
        val device = kind.startsWith("device:")
        AlertDialog(onDismissRequest = { deletion = null }, title = { Text(if (device) "Remove this phone?" else "Delete your account?") },
            text = { Text(if (device) "This phone stops receiving requests. Your other phones and caller credentials remain available."
                else "This permanently removes all phones, app connections, callers, requests, and stored results.") },
            confirmButton = { TextButton(onClick = {
                deletion = null
                when { device -> onRemoveDevice(kind.substringAfter(':')); else -> onDelete() }
            }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deletion = null }) { Text("Keep") } })
    }
}
@Composable
private fun ConnectionPanel(c: ConnectionReview, state: RelayUiState, onDecision: (String, Boolean) -> Unit, onDismiss: () -> Unit) {
    SettingsGroup {
        Text("APP CONNECTION", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
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
        } else Text(when (c.status) { "approved" -> "Connected. The app can now use its own credential."; "denied" -> "Connection declined"; "revoked" -> "Connection revoked. Ask the app for a new link."; else -> "Connection expired. Ask the app for a new link." },
            style = MaterialTheme.typography.titleMedium)
        TextButton(onClick = onDismiss, enabled = !state.busy) { Text(if (pending) "Close" else "Done") }
    }
}
@Composable
private fun AccessStatus(revoked: Boolean, expiresAt: Long, now: Long) {
    Text(if (revoked) "Revoked" else if (expiresAt <= now) "Expired" else "Expires ${DateFormat.getDateInstance().format(Date(expiresAt))}",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
