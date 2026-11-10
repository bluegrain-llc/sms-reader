package com.bluegrain.smsrelay

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UiActionsTest {
    @Test(timeout = 5000) fun credentialCompletionWaitsForForegroundRefreshThenDeletesExactlyOnce() = runBlocking {
        val state = MutableStateFlow(RelayUiState())
        val actions = UiActions(state) { throw AssertionError(it) }
        val refreshDone = CompletableDeferred<Unit>()
        val calls = mutableListOf<String>()
        val refresh = launch(start = CoroutineStart.UNDISPATCHED) {
            actions.run(silent = true) { refreshDone.await() }
        }
        val credentials = launch(start = CoroutineStart.UNDISPATCHED) {
            actions.credentials { calls += "reauthenticate"; calls += "delete"; calls += "clear local data" }
        }
        try {
            actions.run(silent = true) { calls += "overlapping refresh" }
            assertTrue(state.value.busy)
            assertTrue(calls.isEmpty())
            refreshDone.complete(Unit)
            refresh.join(); credentials.join()
            assertEquals(listOf("reauthenticate", "delete", "clear local data"), calls)
            assertFalse(state.value.busy)
        } finally { refreshDone.complete(Unit); refresh.cancelAndJoin(); credentials.cancelAndJoin() }
    }

    @Test(timeout = 5000) fun abandonedCredentialCompletionCancelsWithoutDeletingAfterRefresh() = runBlocking {
        val state = MutableStateFlow(RelayUiState())
        val actions = UiActions(state) { throw AssertionError(it) }
        val refreshDone = CompletableDeferred<Unit>()
        var deleted = false
        val refresh = launch(start = CoroutineStart.UNDISPATCHED) { actions.run { refreshDone.await() } }
        val credentials = launch(start = CoroutineStart.UNDISPATCHED) { actions.credentials { deleted = true } }
        try {
            credentials.cancelAndJoin()
            assertTrue(state.value.busy)
            refreshDone.complete(Unit); refresh.join()
            assertFalse(deleted)
            assertFalse(state.value.busy)
        } finally { refreshDone.complete(Unit); refresh.cancelAndJoin(); credentials.cancelAndJoin() }
    }
}
