package com.bluegrain.smsrelay

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class SmsDiscoveryTest {
    private fun request(id: String, status: String = "pending_phone") =
        PhoneRequest(id, status, "Assistant", "Sign in", null, 0, null, null)

    @Test fun unopenedExpiredRequestIsReplacedByTheServersSuccessor() = runBlocking {
        var displayed: PhoneRequest? = request("old")
        val fetched = mutableListOf<String>()
        refreshSmsDiscovery("next", { false }, { id -> fetched.add(id); request(id) }) { displayed = it }
        assertEquals(listOf("next"), fetched)
        assertEquals("next", displayed?.id)
        assertTrue(displayed?.active == true)
    }

    @Test fun remoteCancellationOrCompletionClearsUnopenedDiscoveryWhenNoSuccessorExists() = runBlocking {
        var displayed: PhoneRequest? = request("old")
        refreshSmsDiscovery(null, { false }, { error("No request is active on the device") }) { displayed = it }
        assertNull(displayed)
    }

    @Test fun refreshReloadsTheSameUnopenedRequestToObserveRemoteTermination() = runBlocking {
        var displayed: PhoneRequest? = request("old")
        refreshSmsDiscovery("old", { false }, { request(it, "completed") }) { displayed = it }
        assertEquals("completed", displayed?.status)
        assertFalse(displayed?.active == true)
    }

    @Test fun refreshPreservesTheBoundListenerWhenServerPointerChanges() = runBlocking {
        val listening = request("listening", "ready")
        var displayed: PhoneRequest? = listening
        refreshSmsDiscovery("next", { true }, { error("Do not replace an active listening session") }) { displayed = it }
        assertSame(listening, displayed)
    }

    @Test fun aListenerBoundDuringFetchIsNotOverwrittenByDiscovery() = runBlocking {
        withTimeout(1_000) {
            var bound = false
            val listening = request("listening", "ready")
            var displayed: PhoneRequest? = listening
            val fetching = CompletableDeferred<Unit>()
            val result = CompletableDeferred<PhoneRequest>()
            val refresh = async {
                refreshSmsDiscovery("old", { bound }, { fetching.complete(Unit); result.await() }) { displayed = it }
            }
            fetching.await()
            bound = true
            result.complete(request("old"))
            refresh.await()
            assertSame(listening, displayed)
        }
    }

    @Test fun onlyAnActiveBoundSessionBlocksOpeningADifferentNotification() {
        val stale = request("old")
        assertFalse(stale.blocksSmsOpen(null, "next"))
        assertTrue(stale.blocksSmsOpen("old", "next"))
        assertFalse(stale.blocksSmsOpen("old", "old"))
        assertFalse(stale.copy(status = "completed").blocksSmsOpen("old", "next"))
    }

    @Test fun successorDiscoveryPreservesTerminalResponseAndKeepsTheInboxCurrent() = runBlocking {
        for (status in listOf("cancelled", "failed", "expired", "completed")) {
            val terminal = request("old", status)
            var state = RelayUiState(request = terminal)
            refreshSmsDiscovery("next", { false }, { request(it) }) { state = state.withSmsDiscovery(it) }
            assertSame(terminal, state.request)
            assertEquals("next", state.pendingSms?.id)
            refreshSmsDiscovery(null, { false }, { error("No active request") }) { state = state.withSmsDiscovery(it) }
            assertSame(terminal, state.request)
            assertNull(state.pendingSms)
        }
    }

    @Test fun completingTheDiscoveredSuccessorDoesNotRestoreItsStaleInboxEntry() {
        val next = request("next")
        val discovered = RelayUiState(request = request("old", "cancelled")).withSmsDiscovery(next)
        val opened = discovered.copy(request = next)
        assertEquals("next", opened.pendingSms?.id)
        val completed = opened.copy(request = next.copy(status = "completed"))
        assertEquals("completed", completed.request?.status)
        assertNull(completed.pendingSms)
    }
}
