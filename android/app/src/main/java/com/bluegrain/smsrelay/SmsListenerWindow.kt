package com.bluegrain.smsrelay

import kotlinx.coroutines.CompletableDeferred

/** One local platform listening window; broadcasts carry no application request ID. */
internal class SmsListenerWindow(private val started: Long, maximumAge: Long = 5 * 60_000L, private val epoch: Long? = null, private val elapsed: () -> Long) {
    val ready = CompletableDeferred<Boolean>()
    private var closed = false
    private var lifetime = maximumAge.coerceIn(0, 5 * 60_000L)
    fun now(fallback: Long) = epoch?.let { it + (elapsed() - started) } ?: fallback
    fun expired() = elapsed() - started >= lifetime
    fun shortenTo(maximumAge: Long) { lifetime = minOf(lifetime, maximumAge.coerceAtLeast(0)) }

    suspend fun accepts(timeout: Boolean, current: () -> Boolean): Boolean {
        if (!ready.await() || closed || !current()) return false
        // An unscoped timeout cannot end a newer window before its own deadline.
        return if (timeout) expired() else !expired()
    }

    fun close() { closed = true; ready.complete(false) }
}
