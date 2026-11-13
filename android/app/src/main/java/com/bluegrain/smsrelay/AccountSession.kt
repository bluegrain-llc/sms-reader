package com.bluegrain.smsrelay

internal suspend fun disconnectBeforeSignOut(
    deviceId: String?,
    unregister: suspend (String) -> Unit,
    finish: () -> Unit,
) {
    if (deviceId != null) {
        try { unregister(deviceId) }
        catch (e: ApiFailure) {
            if (e.status != 404 && !(e.status == 403 && e.reason == "account_deleted")) throw e
        }
    }
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
