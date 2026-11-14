package com.bluegrain.smsrelay

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

class SmsDiscoveryTest {
    private fun request(id: String, status: String = "pending_phone") =
        PhoneRequest(id, status, "Assistant", "Sign in", null, 0, null, null)

    private class BoundSession(pollStoppedAfterOfflineExpiry: Boolean = false) {
        val old = PhoneRequest("old", "ready", "Assistant", "Sign in", null, 300_000, 300_000, null)
        var state = RelayUiState(request = old, codeDraft = if (pollStoppedAfterOfflineExpiry) "" else "manual draft")
        var boundId: String? = old.id
        var window: Any? = if (pollStoppedAfterOfflineExpiry) null else Any()
        val originalWindow = window
        var polling = !pollStoppedAfterOfflineExpiry

        suspend fun refresh(fetch: suspend (String) -> PhoneRequest) {
            val binding = boundId
            val listening = window
            refreshSmsRequest(
                { state.request?.takeIf { it.id == binding && boundId == binding && window === listening } },
                fetch,
            ) { refreshed ->
                state = state.copy(request = refreshed)
                if (!refreshed.active) {
                    boundId = null; window = null; polling = false
                    state = state.copy(codeDraft = "")
                }
            }
        }

    }

    @Test fun foregroundRefreshRecoversExpiredBindingAfterOfflineFailureAndDiscoversSuccessor() = runBlocking {
        // No receiver or poll remains, but the last known server status is still ready.
        val session = BoundSession(pollStoppedAfterOfflineExpiry = true)
        assertFalse(session.polling)
        assertTrue(session.state.request.blocksSmsOpen(session.boundId, "next"))

        session.refresh { session.old.copy(status = "expired") }
        refreshSmsDiscovery("next", { session.boundId != null }, { request(it) }) {
            session.state = session.state.withSmsDiscovery(it)
        }

        assertEquals("expired", session.state.request?.status)
        assertEquals("next", session.state.pendingSms?.id)
        assertFalse(session.state.request.blocksSmsOpen(session.boundId, "next"))
        assertNull(session.window)
        assertEquals(300_000L, session.state.request?.listeningDeadline)
    }

    @Test fun openingSuccessorRevalidatesOldBindingWithoutRequiringTheOldNotification() = runBlocking {
        for (terminal in listOf("expired", "cancelled", "completed", "failed")) {
            val session = BoundSession()
            assertTrue(canOpenSms("next", { session.state.request }, { session.boundId }) {
                session.refresh { session.old.copy(status = terminal) }
            })
            assertEquals(terminal, session.state.request?.status)
            assertNull(session.boundId)
        }
    }

    @Test fun refreshedUnexpiredBindingStillBlocksSuccessorAndPreservesDraftAndWindow() = runBlocking {
        val session = BoundSession()
        assertFalse(canOpenSms("next", { session.state.request }, { session.boundId }) {
            session.refresh { session.old.copy() }
        })
        refreshSmsDiscovery("next", { session.boundId != null }, { error("Keep listening to the bound request") }) {
            session.state = session.state.withSmsDiscovery(it)
        }
        assertTrue(session.state.request.blocksSmsOpen(session.boundId, "next"))
        assertSame(session.originalWindow, session.window)
        assertEquals("manual draft", session.state.codeDraft)
        assertEquals(300_000L, session.state.request?.expiresAt)
        assertEquals(300_000L, session.state.request?.listeningDeadline)
        assertTrue(session.polling)
    }

    @Test fun offlineRevalidationKeepsTheCurrentBindingInsteadOfStartingAnotherListener() = runBlocking {
        val session = BoundSession()
        try {
            canOpenSms("next", { session.state.request }, { session.boundId }) {
                session.refresh { throw IOException("offline") }
            }
            fail("An unverified session cannot be released")
        } catch (_: IOException) { }
        assertTrue(session.state.request.blocksSmsOpen(session.boundId, "next"))
        assertSame(session.originalWindow, session.window)
        assertEquals("manual draft", session.state.codeDraft)
    }

    @Test fun reopeningCurrentRequestDoesNotRunTheSuccessorRevalidationGate() = runBlocking {
        val session = BoundSession()
        assertTrue(canOpenSms("old", { session.state.request }, { session.boundId }) {
            error("The normal current-request open handles its own refresh")
        })
        assertEquals("manual draft", session.state.codeDraft)
        assertSame(session.originalWindow, session.window)
    }

    @Test fun oldRefreshCannotClearSuccessorOrRestoreARequestAfterAnotherRefreshEndsIt() = runBlocking {
        withTimeout(1_000) {
            for (replaceWithSuccessor in listOf(false, true)) {
                val session = BoundSession()
                val fetching = CompletableDeferred<Unit>()
                val result = CompletableDeferred<PhoneRequest>()
                val refresh = async {
                    session.refresh { fetching.complete(Unit); result.await() }
                }
                fetching.await()
                session.refresh { session.old.copy(status = "expired") }
                val replacementWindow = Any()
                if (replaceWithSuccessor) {
                    session.state = session.state.copy(request = request("next", "ready"), codeDraft = "new draft")
                    session.boundId = "next"; session.window = replacementWindow
                }
                result.complete(session.old)
                refresh.await()
                if (replaceWithSuccessor) {
                    assertEquals("next", session.state.request?.id)
                    assertEquals("new draft", session.state.codeDraft)
                    assertSame(replacementWindow, session.window)
                } else {
                    assertEquals("expired", session.state.request?.status)
                    assertNull(session.boundId)
                }
            }
        }
    }

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
