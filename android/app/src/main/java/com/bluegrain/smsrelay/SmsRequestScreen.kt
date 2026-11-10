package com.bluegrain.smsrelay

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun SmsRequestScreen(
    request: PhoneRequest, state: RelayUiState,
    onCodeChange: (String, String) -> Unit, onSelectCandidate: (String, String) -> Unit,
    onSend: (String) -> Unit, onCancel: () -> Unit, onClose: () -> Unit, onSent: () -> Unit,
) {
    val sentHere = request.status == "completed" && request.reason != "handled_on_another_device"
    LaunchedEffect(request.id, request.status, request.reason) { if (sentHere) onSent() }
    val seconds = ((request.listeningDeadline ?: request.expiresAt) - state.now).coerceAtLeast(0) / 1000
    val active = request.active && seconds > 0
    val canSend = active && request.status in setOf("ready", "awaiting_consent") &&
        !state.busy && !state.cancelling && CodeExtractor.validCode(state.codeDraft.trim())
    BackHandler(onBack = onClose)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState())
            .padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (!sentHere) TextButton(onClick = onClose, modifier = Modifier.heightIn(min = 48.dp)) { Text("Close") }
            Text("${request.caller} — ${request.title}", style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold)
            MarkdownMessage(request.purpose)
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            if (request.active) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(value = state.codeDraft, onValueChange = { onCodeChange(request.id, it) },
                        label = { Text("SMS code") }, singleLine = true,
                        enabled = active && !state.busy && !state.cancelling,
                        textStyle = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None,
                            keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
                        supportingText = { Text(if (state.autofillDeclined) "SMS access declined. Enter the code yourself."
                            else if (state.codeDraft.isNotBlank() && !CodeExtractor.validCode(state.codeDraft.trim())) "Use 4–10 letters or digits, including at least one digit."
                            else "Enter a code and tap Send, or approve Android’s prompt to send automatically.") },
                        modifier = Modifier.fillMaxWidth())
                    if (state.candidates.size > 1) {
                        Text("Choose the code to send", style = MaterialTheme.typography.labelLarge)
                        state.candidates.forEach { code ->
                            OutlinedButton(onClick = { onSelectCandidate(request.id, code) },
                                enabled = active && !state.busy, modifier = Modifier.fillMaxWidth()) {
                                Text("Send $code", fontFamily = FontFamily.Monospace)
                            }
                        }
                    }
                    Button(onClick = { onSend(request.id) }, enabled = canSend,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) { Text(if (state.busy) "Please wait…" else "Send") }
                    Text(if (!active) "Request expired" else if (request.status == "pending_phone") "Preparing SMS reception…"
                        else "Expires in %d:%02d".format(seconds / 60, seconds % 60),
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = onCancel, enabled = !state.cancelling,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Cancel request") }
                }
            } else {
                Text(when {
                    request.reason == "handled_on_another_device" -> "Handled on another phone"
                    request.status == "completed" -> "Code sent"
                    request.status == "cancelled" -> "Request cancelled"
                    request.status == "denied" -> "Request declined"
                    request.status == "expired" -> "Request expired"
                    else -> "Request could not finish"
                }, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
            }
        }
    }
}
