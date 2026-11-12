package com.bluegrain.smsrelay

/** Refresh receiving capabilities before explicitly resuming a phone during onboarding. */
internal suspend fun registerReceivingPhone(
    resumePaused: Boolean,
    register: suspend () -> Boolean,
    resume: suspend () -> Unit
): Boolean {
    val paused = register()
    if (resumePaused && paused) {
        resume()
        return false
    }
    return paused
}
