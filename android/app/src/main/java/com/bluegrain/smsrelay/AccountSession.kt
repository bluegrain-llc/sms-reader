package com.bluegrain.smsrelay

internal suspend fun disconnectBeforeSignOut(
    deviceId: String?,
    unregister: suspend (String) -> Unit,
    finish: () -> Unit,
) {
    if (deviceId != null) unregister(deviceId)
    finish()
}

internal suspend fun linkForOwner(
    expectedOwner: String,
    currentOwner: () -> String?,
    link: suspend () -> String?,
) {
    check(expectedOwner.isNotEmpty() && currentOwner() == expectedOwner)
    check(link() == expectedOwner)
    check(currentOwner() == expectedOwner)
}
