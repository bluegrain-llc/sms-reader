package com.bluegrain.smsrelay

internal suspend fun disconnectBeforeSignOut(
    deviceId: String?,
    unregister: suspend (String) -> Unit,
    finish: () -> Unit,
) {
    if (deviceId != null) unregister(deviceId)
    finish()
}
