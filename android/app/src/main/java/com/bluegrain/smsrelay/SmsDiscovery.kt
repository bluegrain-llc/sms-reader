package com.bluegrain.smsrelay

internal fun RelayUiState.withSmsDiscovery(discovered: PhoneRequest?) = copy(
    request = if (request?.active == false) request else discovered,
    discoveredRequest = discovered,
)

internal val RelayUiState.pendingSms: PhoneRequest?
    get() = request?.takeIf { it.active }
        ?: discoveredRequest?.takeIf { it.active && it.id != request?.id }

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
