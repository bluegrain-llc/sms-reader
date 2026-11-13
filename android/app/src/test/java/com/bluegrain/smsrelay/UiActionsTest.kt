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

    @Test(timeout = 5000) fun appleDeletionWaitsForRefreshAndHoldsCredentialsThroughRevocation() = runBlocking {
        val state = MutableStateFlow(RelayUiState())
        val errors = mutableListOf<String>()
        val actions = UiActions(state, errors::add)
        val refreshDone = CompletableDeferred<Unit>()
        val revokeDone = CompletableDeferred<Unit>()
        val calls = mutableListOf<String>()
        val refresh = launch(start = CoroutineStart.UNDISPATCHED) { actions.run { refreshDone.await() } }
        val deletion = launch(start = CoroutineStart.UNDISPATCHED) {
            actions.reauthenticatedDeletion("owner-a", { "owner-a" },
                reauthenticate = { calls += "reauthenticate"; "owner-a" },
                revoke = { calls += "revoke"; revokeDone.await() },
                delete = { calls += "delete:$it" })
        }
        try {
            assertTrue(calls.isEmpty())
            refreshDone.complete(Unit); refresh.join()
            kotlinx.coroutines.yield()
            assertEquals(listOf("reauthenticate", "revoke"), calls)
            assertTrue(state.value.busy)
            actions.run { calls += "overlapping account action" }
            revokeDone.complete(Unit); deletion.join()
            assertEquals(listOf("reauthenticate", "revoke", "delete:owner-a"), calls)
            assertTrue(errors.isEmpty()); assertFalse(state.value.busy)
        } finally { refreshDone.complete(Unit); revokeDone.complete(Unit); refresh.cancelAndJoin(); deletion.cancelAndJoin() }
    }

    @Test(timeout = 5000) fun appleDeletionRejectsOwnerChangeWhileRevocationIsPending() = runBlocking {
        val state = MutableStateFlow(RelayUiState())
        val errors = mutableListOf<String>()
        val actions = UiActions(state, errors::add)
        val revokeDone = CompletableDeferred<Unit>()
        var owner = "owner-a"
        val deleted = mutableListOf<String>()
        val deletion = launch(start = CoroutineStart.UNDISPATCHED) {
            actions.reauthenticatedDeletion("owner-a", { owner }, { "owner-a" },
                revoke = { revokeDone.await() }, delete = deleted::add)
        }
        try {
            assertTrue(state.value.busy)
            owner = "owner-b"
            revokeDone.complete(Unit); deletion.join()
            assertTrue(deleted.isEmpty()); assertEquals(1, errors.size); assertFalse(state.value.busy)
        } finally { revokeDone.complete(Unit); deletion.cancelAndJoin() }
    }

    @Test(timeout = 5000) fun deletionRejectsOwnerChangedBeforeQueuedCredentialsBegin() = runBlocking {
        val state = MutableStateFlow(RelayUiState())
        val errors = mutableListOf<String>()
        val actions = UiActions(state, errors::add)
        val refreshDone = CompletableDeferred<Unit>()
        var owner = "owner-a"
        val calls = mutableListOf<String>()
        val refresh = launch(start = CoroutineStart.UNDISPATCHED) { actions.run { refreshDone.await() } }
        val deletion = launch(start = CoroutineStart.UNDISPATCHED) {
            actions.reauthenticatedDeletion("owner-a", { owner }, { calls += "reauthenticate"; owner },
                revoke = { calls += "revoke" }, delete = { calls += "delete:$it" })
        }
        try {
            owner = "owner-b"; refreshDone.complete(Unit)
            refresh.join(); deletion.join()
            assertTrue(calls.isEmpty()); assertEquals(1, errors.size); assertFalse(state.value.busy)
        } finally { refreshDone.complete(Unit); refresh.cancelAndJoin(); deletion.cancelAndJoin() }
    }

    @Test(timeout = 5000) fun deletionRejectsDifferentReauthenticatedUserBeforeRevocation() = runBlocking {
        val state = MutableStateFlow(RelayUiState())
        val errors = mutableListOf<String>()
        val actions = UiActions(state, errors::add)
        val calls = mutableListOf<String>()
        actions.reauthenticatedDeletion("owner-a", { "owner-a" }, { "owner-b" },
            revoke = { calls += "revoke" }, delete = { calls += "delete:$it" })
        assertTrue(calls.isEmpty()); assertEquals(1, errors.size); assertFalse(state.value.busy)
    }
}
