package com.bluegrain.smsrelay

internal fun RelayUiState.withSmsDiscovery(discovered: PhoneRequest?) = copy(
    request = if (request?.active == false) request else discovered,
    discoveredRequest = discovered,
)

internal val RelayUiState.pendingSms: PhoneRequest?
    get() = request?.takeIf { it.active }
        ?: discoveredRequest?.takeIf { it.active && it.id != request?.id }

// A fetch can overlap polling, cancellation or opening a successor. Apply its result
// only to the exact request snapshot that initiated it.
internal suspend fun refreshSmsRequest(
    current: () -> PhoneRequest?,
    fetch: suspend (String) -> PhoneRequest,
    apply: (PhoneRequest) -> Unit,
) {
    val before = current() ?: return
    val refreshed = fetch(before.id)
    if (current() === before) apply(refreshed)
}

internal suspend fun refreshSmsDiscovery(
    activeRequestId: String?,
    hasListener: () -> Boolean,
    fetch: suspend (String) -> PhoneRequest,
    show: (PhoneRequest?) -> Unit,
) {
    if (hasListener()) return
    val request = activeRequestId?.let { fetch(it) }
    if (!hasListener()) show(request)
}

internal fun PhoneRequest?.blocksSmsOpen(boundId: String?, targetId: String) =
    boundId != null && this?.active == true && id != targetId

internal suspend fun canOpenSms(
    targetId: String,
    current: () -> PhoneRequest?,
    boundId: () -> String?,
    refresh: suspend (String) -> Unit,
): Boolean {
    boundId()?.takeIf { it != targetId }?.let { refresh(it) }
    return !current().blocksSmsOpen(boundId(), targetId)
}
