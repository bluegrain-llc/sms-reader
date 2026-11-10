package com.bluegrain.smsrelay

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine

enum class RequestOrigin { Inbox, Notification }
enum class RequestKind { Sms, Form }
enum class SettingsSection(val title: String) { Access("Access"), Devices("Devices"), History("History") }
data class RequestTarget(val id: String, val kind: RequestKind)
sealed interface RelayDestination {
    data object Inbox : RelayDestination
    data class Settings(val section: SettingsSection = SettingsSection.Access) : RelayDestination
    data class Response(val target: RequestTarget, val origin: RequestOrigin) : RelayDestination
}

// Only these non-sensitive navigation values are saved across process recreation.
fun RelayDestination.metadata(): List<String> = when (this) {
    RelayDestination.Inbox -> listOf("inbox")
    is RelayDestination.Settings -> listOf("settings", section.name)
    is RelayDestination.Response -> listOf("response", target.id, target.kind.name, origin.name)
}
fun restoreDestination(values: List<String>?): RelayDestination = runCatching {
    when (values?.firstOrNull()) {
        "settings" -> RelayDestination.Settings(SettingsSection.valueOf(values[1]))
        "response" -> RelayDestination.Response(RequestTarget(values[1], RequestKind.valueOf(values[2])), RequestOrigin.valueOf(values[3]))
        else -> RelayDestination.Inbox
    }
}.getOrDefault(RelayDestination.Inbox)

fun RelayDestination.backgroundOnClose() = this is RelayDestination.Response && origin == RequestOrigin.Notification

// The target is kept by navigation while authentication, registration or another action finishes.
internal suspend fun loadResponseWhenReady(
    target: RequestTarget,
    session: StateFlow<RelayUiState>,
    inbox: StateFlow<InboxState>,
    openSms: suspend (String) -> Boolean,
    openForm: suspend (String) -> Boolean,
    onFormEntry: () -> Unit = {},
): Boolean {
    fun ready(s: RelayUiState, i: InboxState) = s.configured && s.signedIn && s.registered && when {
        target.kind == RequestKind.Sms && s.hasRetainedOutcome(target.id) && !s.opening -> true
        target.kind == RequestKind.Form && i.form?.id == target.id && i.openingForms == 0 -> true
        else -> !s.busy && !s.opening && !i.busy && i.openingForms == 0
    }
    while (true) {
        combine(session, inbox) { s, i -> ready(s, i) }.first { it }
        val readySession = session.value
        val readyInbox = inbox.value
        if (!ready(readySession, readyInbox)) continue
        // A retained outcome needs no network fetch; active SMS still requires explicit opening.
        if (target.kind == RequestKind.Sms && readySession.hasRetainedOutcome(target.id)) return true
        // Rotation keeps the current form, draft and confirmation in the same ViewModel.
        if (target.kind == RequestKind.Form && readyInbox.form?.id == target.id) {
            onFormEntry()
            return true
        }
        return when (target.kind) {
            RequestKind.Sms -> openSms(target.id)
            RequestKind.Form -> { onFormEntry(); openForm(target.id) }
        }
    }
}

private fun RelayUiState.hasRetainedOutcome(id: String) = request?.let {
    it.id == id && it.status in setOf("completed", "cancelled", "failed", "expired", "denied")
} == true
