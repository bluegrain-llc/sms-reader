package com.bluegrain.smsrelay

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
private fun label(status: String) = when (status) {
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
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}
@Composable
fun RelayScreen(
    state: RelayUiState, onSignIn: () -> Unit = {}, onRegister: () -> Unit = {}, onRefresh: () -> Unit = {},
    onPause: () -> Unit = {}, onCancel: () -> Unit = {}, onRevoke: (String) -> Unit = {},
    onSubmitCode: (String) -> Unit = {}, onCodeChange: (String, String) -> Unit = { _, _ -> },
    onSelectCandidate: (String, String) -> Unit = { _, _ -> }, onDismissRequest: () -> Unit = {}, onRequestSent: () -> Unit = {}, onDelete: () -> Unit = {},
    onPauseDevice: (String) -> Unit = {}, onRemoveDevice: (String) -> Unit = {},
    onReviewConnection: (String) -> Unit = {}, onConnectionDecision: (String, Boolean) -> Unit = { _, _ -> }, onDismissConnection: () -> Unit = {},
) {
    state.request?.let {
        SmsRequestScreen(it, state, onCodeChange, onSelectCandidate, onSubmitCode, onCancel, onDismissRequest, onRequestSent)
        return
    }
    var connectionCode by remember(state.connectionCode) { mutableStateOf(state.connectionCode.orEmpty()) }
    var tab by remember { mutableIntStateOf(0) }
    var adminTab by remember { mutableIntStateOf(0) }
    var deletion by remember { mutableStateOf<String?>(null) }
    // An incoming request always brings the owner back to the approval area.
    LaunchedEffect(state.request?.id) { if (state.request?.active == true) tab = 0 }
    LaunchedEffect(state.connection?.code, state.connectionCode) { if (state.connection != null || state.connectionCode != null) { tab = 1; adminTab = 0 } }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        LazyColumn(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp), contentPadding = PaddingValues(vertical = 24.dp)) {
            item {
                Text("SMS CODE RELAY", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                if (state.connection == null && (tab == 1 || state.request?.active != true)) {
                    Spacer(Modifier.height(8.dp))
                    Text(if (tab == 1) "You control access." else "Your phone.\nYour permission.",
                        fontSize = 32.sp, lineHeight = 36.sp, letterSpacing = (-0.5).sp, fontWeight = FontWeight.SemiBold)
                }
            }
            if (state.busy) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            state.error?.let { message -> item {
                Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(12.dp)) {
                    Text(message, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onErrorContainer)
                }
            } }
            if (!state.configured) item {
                Panel {
                    Text("Pilot setup needed", style = MaterialTheme.typography.titleLarge)
                    Text("This build has no service connection yet. Ask the operator for a configured pilot APK.")
                }
            } else if (!state.signedIn) item {
                Panel {
                    Text("One code, only with permission", style = MaterialTheme.typography.titleLarge)
                    Text("Sign in and allow notifications to connect this phone. Android asks before sharing an incoming SMS; only the approved code reaches the caller.")
                    Text("The app cannot read your inbox or retrieve old messages.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = onSignIn, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Continue with Google") }
                }
            } else {
                item {
                    PrimaryTabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background) {
                        listOf("Relay", "Admin").forEachIndexed { i, title ->
                            Tab(selected = tab == i, onClick = { tab = i }, text = { Text(title) })
                        }
                    }
                }
                if (tab == 0) {
                    if (state.request?.active != true) item {
                        Panel {
                            Text(if (!state.registered) "Connect this phone" else if (state.paused) "This phone is paused" else "Ready for requests", style = MaterialTheme.typography.titleLarge)
                            Text(state.email, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(if (!state.registered) "Allow notifications to finish connecting. Your usual messaging app stays available."
                                else if (state.paused) "Your other available phones still receive requests."
                                else "Tap a request notification, then approve or decline in Android’s SMS dialog.")
                            if (!state.registered) Button(onClick = onRegister, enabled = !state.busy) { Text("Finish connecting") }
                            else OutlinedButton(onClick = onPause, enabled = !state.busy) { Text(if (state.paused) "Resume this phone" else "Pause this phone") }
                            Text("Requests reach all your available phones. The first approved code completes the request.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    item { TextButton(onClick = onRefresh, enabled = !state.busy) { Text("Refresh status") } }
                } else {
                    item {
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            listOf("Access", "Devices", "History").forEachIndexed { i, title ->
                                SegmentedButton(selected = adminTab == i, onClick = { adminTab = i },
                                    shape = SegmentedButtonDefaults.itemShape(i, 3)) { Text(title) }
                            }
                        }
                    }
                    when (adminTab) {
                        0 -> {
                            state.connection?.let { connection -> item {
                                ConnectionPanel(connection, state, onConnectionDecision, onDismissConnection)
                            } }
                            item { Panel {
                                Text("Connect an app or bot", style = MaterialTheme.typography.titleLarge)
                                Text("Open the connection link your app or bot shows. Review it here and approve once. Its credential is delivered automatically.")
                                OutlinedTextField(value = connectionCode, onValueChange = { connectionCode = it.uppercase().take(32) },
                                    label = { Text("Connection code (if needed)") }, placeholder = { Text("ABCDE-FG234") },
                                    singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth())
                                OutlinedButton(onClick = { onReviewConnection(connectionCode.trim()) },
                                    enabled = !state.busy && Regex("^[A-HJ-NP-Z2-9]{10}$").matches(connectionCode.replace("-", "").replace(" ", ""))) { Text("Review connection") }
                            } }
                            item {
                                Text("Connected apps and bots", style = MaterialTheme.typography.titleLarge)
                                if (state.grants.isEmpty()) Text("Your approved connections appear here. Each app gets its own credential.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            state.grants.forEach { grant -> item { Panel {
                                Text(grant.name, style = MaterialTheme.typography.titleMedium)
                                AccessStatus(grant.revoked, grant.expiresAt, state.now)
                                if (!grant.revoked && grant.expiresAt > state.now) TextButton(onClick = { onRevoke(grant.id) }, enabled = !state.busy) { Text("Revoke caller") }
                            } } }
                        }
                        1 -> {
                            item {
                                Text("Your phones", style = MaterialTheme.typography.titleLarge)
                                Text("Sign in with the same Google account on another phone to add it. Requests notify every available phone.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (state.devices.isEmpty()) item { Button(onClick = onRegister, enabled = !state.busy) { Text("Connect this phone") } }
                            state.devices.forEach { device -> item { Panel {
                                Text(device.name, style = MaterialTheme.typography.titleMedium)
                                Text((if (device.current) "This phone · " else "") + if (device.paused) "Paused" else "Receives requests", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(onClick = { onPauseDevice(device.id) }, enabled = !state.busy) { Text(if (device.paused) "Resume" else "Pause") }
                                    TextButton(onClick = { deletion = "device:" + device.id }, enabled = !state.busy) { Text("Remove", color = MaterialTheme.colorScheme.error) }
                                }
                            } } }
                            item { Panel {
                                Text("Account", style = MaterialTheme.typography.titleMedium)
                                Text(state.email, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text("Sign in again before deleting your account.", style = MaterialTheme.typography.bodySmall)
                                TextButton(onClick = onSignIn, enabled = !state.busy) { Text("Sign in again") }
                                TextButton(onClick = { deletion = "account" }, enabled = !state.busy) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
                            } }
                        }
                        2 -> {
                            item {
                                Text("Recent outcomes", style = MaterialTheme.typography.titleLarge)
                                Text("Seven days of requests across your phones. Codes and messages never appear here.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (state.history.isEmpty()) item { Text("No requests yet.") }
                            state.history.forEach { row -> item {
                                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Text(row.caller, fontWeight = FontWeight.Medium)
                                    Text(label(row.status), color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    row.reason?.let { Text(it.replace('_', ' '), style = MaterialTheme.typography.bodySmall) }
                                }
                            } }
                        }
                    }
                    item { TextButton(onClick = onRefresh, enabled = !state.busy) { Text("Refresh admin") } }
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
    Panel {
        Text("APP CONNECTION", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        Text(c.caller, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
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
