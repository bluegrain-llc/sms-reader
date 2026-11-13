package com.bluegrain.smsrelay

internal suspend fun disconnectBeforeSignOut(
    deviceId: String?,
    unregister: suspend (String) -> Unit,
    finish: () -> Unit,
    sessionUnavailable: suspend (Exception) -> Boolean = { false },
) {
    if (deviceId != null) {
        try { unregister(deviceId) }
        catch (e: Exception) {
            val disconnected = e is ApiFailure && (e.status == 404 || (e.status == 403 && e.reason == "account_deleted"))
            if (!disconnected && !sessionUnavailable(e)) throw e
        }
    }
    finish()
}

internal suspend fun unavailableSignOutSession(
    failure: Exception,
    isInvalidSession: (Exception) -> Boolean,
    reload: suspend () -> Unit,
): Boolean {
    if (isInvalidSession(failure)) return true
    if (failure !is ApiFailure || failure.status != 401 || failure.reason != "invalid_owner_session") return false
    // Both servers also map temporary verifier failures to this response.
    try { reload() }
    catch (e: Exception) {
        if (isInvalidSession(e)) return true
        throw e
    }
    return false
}

internal fun finishSignOutForOwner(expectedOwner: String, currentOwner: String?, sessionUnavailable: Boolean, finish: () -> Unit) {
    check(expectedOwner.isNotBlank() && (currentOwner == expectedOwner || (sessionUnavailable && currentOwner == null))) {
        "The signed-in account changed."
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
