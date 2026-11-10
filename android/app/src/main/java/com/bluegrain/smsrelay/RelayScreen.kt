package com.bluegrain.smsrelay

import androidx.compose.runtime.Composable

@Composable
fun RelayScreen(
    state: RelayUiState, destination: RelayDestination = RelayDestination.Inbox,
    formState: InboxState = InboxState(), deviceId: String = "", responseReady: Boolean = false, responseLoading: Boolean = true, openingTarget: RequestTarget? = null, refreshing: Boolean = false,
    onAdministration: () -> Unit = {}, onBack: () -> Unit = {}, onRetry: () -> Unit = {},
    onSignIn: () -> Unit = {}, onRegister: () -> Unit = {}, onRefresh: () -> Unit = {},
    onCancel: () -> Unit = {},
    onSubmitCode: (String) -> Unit = {}, onCodeChange: (String, String) -> Unit = { _, _ -> },
    onSelectCandidate: (String, String) -> Unit = { _, _ -> }, onRequestSent: () -> Unit = {},
    onOpenForm: (String) -> Unit = {}, onOpenSms: (String) -> Unit = {},
    onFormChange: (String, Any) -> Unit = { _, _ -> }, onFormSubmit: (FormAction) -> Unit = {}, onFormRendered: (String) -> Unit = {},
    onFormListen: (FormField) -> Unit = {}, onFormCandidate: (String) -> Unit = {}, onFormNext: () -> Unit = {}, onFormPrevious: () -> Unit = {},
) {
    when (destination) {
        RelayDestination.Inbox -> InboxScreen(state, formState.requests, onAdministration, onRefresh, onOpenSms, onOpenForm, refreshing, openingTarget)
        is RelayDestination.Response -> {
            val target = destination.target
            when {
                responseReady && state.signedIn && state.registered && target.kind == RequestKind.Sms && state.request?.id == target.id ->
                    SmsRequestScreen(state.request, state, onCodeChange, onSelectCandidate, onSubmitCode, onCancel, onBack, onRequestSent)
                responseReady && state.signedIn && state.registered && target.kind == RequestKind.Form && formState.form?.id == target.id ->
                    RequestFormScreen(formState, deviceId, onBack, onFormChange, onFormSubmit, onFormRendered,
                        onFormListen, onFormCandidate, onFormNext, onFormPrevious)
                else -> ResponseEntryScreen(state.copy(error = if (target.kind == RequestKind.Form) formState.error ?: state.error else state.error), responseLoading,
                    onBack, onSignIn, onRegister, onRetry)
            }
        }
    }
}
