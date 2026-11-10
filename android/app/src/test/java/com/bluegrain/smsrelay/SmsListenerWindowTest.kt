package com.bluegrain.smsrelay

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class SmsListenerWindowTest {
    @Test(timeout = 5000) fun earlyTimeoutDoesNotSpendOrExtendCurrentWindow() = runBlocking {
        var elapsed = 1_000L
        val window = SmsListenerWindow(elapsed) { elapsed }
        window.ready.complete(true)
        elapsed += 378
        assertFalse(window.accepts(timeout = true) { true })
        assertTrue(window.accepts(timeout = false) { true })
        elapsed = 300_999
        assertFalse(window.accepts(timeout = true) { true })
        elapsed++
        assertTrue(window.expired())
        assertTrue(window.accepts(timeout = true) { true })
        assertFalse(window.accepts(timeout = false) { true })
        window.close()
        assertFalse(window.accepts(timeout = true) { true })
    }

    @Test(timeout = 5000) fun callbacksWaitingForReadyRecheckCancellationAndRebinding() = runBlocking {
        for (timeout in listOf(false, true)) {
            val window = SmsListenerWindow(0) { if (timeout) 300_000 else 378 }
            var current = true
            val decision = async(start = CoroutineStart.UNDISPATCHED) { window.accepts(timeout) { current } }
            try {
                assertFalse(decision.isCompleted)
                current = false
                window.ready.complete(true)
                assertFalse(withTimeout(1000) { decision.await() })
            } finally { window.close(); decision.cancel() }
        }
        val window = SmsListenerWindow(0) { 300_000 }
        val decision = async(start = CoroutineStart.UNDISPATCHED) { window.accepts(true) { true } }
        try {
            window.close()
            assertFalse(withTimeout(1000) { decision.await() })
        } finally { window.close(); decision.cancel() }
    }

    @Test(timeout = 5000) fun readinessDoesNotResetClockAndWallTimeIsNotAnInput() = runBlocking {
        var elapsed = 100L
        val window = SmsListenerWindow(elapsed) { elapsed }
        val decision = async(start = CoroutineStart.UNDISPATCHED) { window.accepts(true) { true } }
        try {
            elapsed = 110L
            window.ready.complete(true)
            assertFalse(withTimeout(1000) { decision.await() })
            // Readiness and repeated early broadcasts never renew the captured monotonic start.
            elapsed = 300_100L
            assertTrue(window.accepts(true) { true })
        } finally { window.close(); decision.cancel() }
    }
    @Test(timeout = 5000) fun earlierRequestDeadlineCanShortenButNeverRenewWindow() = runBlocking {
        var elapsed = 1_000L
        val window = SmsListenerWindow(elapsed, 30_000) { elapsed }
        window.ready.complete(true)
        window.shortenTo(20_000)
        window.shortenTo(300_000)
        elapsed = 20_999
        assertFalse(window.expired())
        elapsed++
        assertTrue(window.expired())
        assertFalse(window.accepts(false) { true })
        assertTrue(window.accepts(true) { true })
    }

}
