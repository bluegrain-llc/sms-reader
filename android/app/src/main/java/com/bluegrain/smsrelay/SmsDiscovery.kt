package com.bluegrain.smsrelay

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
