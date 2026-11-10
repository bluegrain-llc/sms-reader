package com.bluegrain.smsrelay

import kotlinx.coroutines.CompletableDeferred

/** One local platform listening window; broadcasts carry no application request ID. */
internal class SmsListenerWindow(private val started: Long, private val elapsed: () -> Long) {
    val ready = CompletableDeferred<Boolean>()
    private var closed = false
    fun expired() = elapsed() - started >= 5 * 60_000L

    suspend fun accepts(timeout: Boolean, current: () -> Boolean): Boolean {
        if (!ready.await() || closed || !current()) return false
        // An unscoped timeout cannot end a newer window before its own five minutes.
        return if (timeout) expired() else !expired()
    }

    fun close() { closed = true; ready.complete(false) }
}
