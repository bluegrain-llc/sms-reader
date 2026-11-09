package com.bluegrain.smsrelay

import android.app.DatePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

@Composable
fun RequestFormScreen(state: InboxState, deviceId: String, onBack: () -> Unit,
    onChange: (String, Any) -> Unit, onSubmit: (FormAction) -> Unit, onRendered: (String) -> Unit,
    onListen: (FormField) -> Unit, onCandidate: (String) -> Unit) {
    val form = state.form ?: return
    BackHandler { if (!state.busy) onBack() }
    LaunchedEffect(form.id, state.foreground) {
        if (state.foreground) { withFrameNanos { }; onRendered(form.id) }
    }
    val active = form.status == "pending" && state.now < form.expiresAt
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)) {
            TextButton(onClick = onBack, enabled = !state.busy) { Text("Back to inbox") }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(form.caller, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text(form.title, style = MaterialTheme.typography.headlineMedium)
                Text("Expires ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(form.expiresAt))}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            MarkdownMessage(form.body)
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (active) {
                form.fields.forEach { field -> FormFieldControl(field, state.values[field.id], !state.busy, { onChange(field.id, it) }) {
                    onListen(field)
                } }
                state.helper?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                state.candidates.forEach { code -> OutlinedButton(onClick = { onCandidate(code) }, enabled = !state.busy) { Text("Use $code") } }
                Text("Opening this request does not send a response. Choose an action below when you are ready.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                form.actions.forEach { action ->
                    if (action.type == "decline") OutlinedButton(onClick = { onSubmit(action) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(action.label) }
                    else Button(onClick = { onSubmit(action) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(action.label) }
                }
            } else {
                Text(if (form.completedBy != null && form.completedBy != deviceId) "Answered on another phone."
                    else if (form.status == "submitted") "Your response was accepted."
                    else if (form.status == "pending") "This request has expired." else "Request ${form.status}.", style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

@Composable
private fun FormFieldControl(field: FormField, value: Any?, enabled: Boolean, change: (Any) -> Unit, listen: () -> Unit) {
    val label = field.label + if (field.required) " *" else ""
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (field.type) {
            "checkbox" -> Row(Modifier.fillMaxWidth().clickable(enabled = enabled) { change(value != true) }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Checkbox(checked = value == true, onCheckedChange = { change(it) }, enabled = enabled)
                Text(label, Modifier.padding(top = 12.dp))
            }
            "single_choice", "multiple_choice" -> {
                Text(label, style = MaterialTheme.typography.titleSmall)
                field.options.forEach { (id, text) ->
                    val selected = if (field.type == "single_choice") value == id else (value as? Set<*>)?.contains(id) == true
                    fun select() { if (field.type == "single_choice") change(id) else {
                        val current = (value as? Set<*>)?.filterIsInstance<String>()?.toSet().orEmpty()
                        change(if (selected) current - id else current + id)
                    } }
                    Row(Modifier.fillMaxWidth().clickable(enabled = enabled) { select() }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (field.type == "single_choice") RadioButton(selected = selected, onClick = { select() }, enabled = enabled)
                        else Checkbox(checked = selected, onCheckedChange = { select() }, enabled = enabled)
                        Text(text, Modifier.padding(top = 12.dp))
                    }
                }
            }
            "date" -> {
                val context = LocalContext.current
                Text(label, style = MaterialTheme.typography.titleSmall)
                OutlinedButton(onClick = {
                    val c = Calendar.getInstance()
                    DatePickerDialog(context, { _, year, month, day -> change(String.format(Locale.ROOT, "%04d-%02d-%02d", year, month + 1, day)) },
                        c.get(Calendar.YEAR), c.get(Calendar.MONTH), c.get(Calendar.DAY_OF_MONTH)).show()
                }, enabled = enabled) { Text(value as? String ?: "Choose a date") }
            }
            else -> {
                OutlinedTextField(value = value as? String ?: "", onValueChange = { change(it.take(field.maxLength)) },
                    label = { Text(label) }, enabled = enabled, singleLine = field.type != "multiline",
                    minLines = if (field.type == "multiline") 3 else 1, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = if (field.type == "number") KeyboardType.Decimal else KeyboardType.Text),
                    supportingText = if (field.type == "number" && (field.min != null || field.max != null)) { { Text("Range: ${field.min ?: "any"} to ${field.max ?: "any"}") } } else null)
                if (field.sms) OutlinedButton(onClick = listen, enabled = enabled) { Text("Autofill from an upcoming SMS") }
            }
        }
    }
}
