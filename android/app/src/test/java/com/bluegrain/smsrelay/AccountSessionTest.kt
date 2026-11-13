package com.bluegrain.smsrelay

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountSessionTest {
    private class InvalidSession : Exception()

    @Test(timeout = 5000) fun linkRejectsOwnerChangedWhileCredentialsArePending() = runBlocking {
        var owner = "owner-a"
        val credentials = CompletableDeferred<Unit>()
        var linked = false
        var rejected = false
        val operation = launch(start = CoroutineStart.UNDISPATCHED) {
            credentials.await()
            try { linkForOwner("owner-a", { owner }) { linked = true; owner } }
            catch (_: IllegalStateException) { rejected = true }
        }
        try {
            owner = "owner-b"; credentials.complete(Unit); operation.join()
            assertTrue(rejected); assertFalse(linked)
        } finally { credentials.complete(Unit); operation.cancelAndJoin() }
    }

    @Test(timeout = 5000) fun linkRemainsBoundToTheConsentingOwnerAcrossItsResult() = runBlocking {
        var owner = "owner-a"
        var linked = false
        linkForOwner("owner-a", { owner }) { linked = true; "owner-a" }
        assertTrue(linked)
        var rejected = false
        try { linkForOwner("owner-a", { owner }) { owner = "owner-b"; "owner-a" } }
        catch (_: IllegalStateException) { rejected = true }
        assertTrue(rejected)
    }

    @Test(timeout = 5000) fun signOutRetainsInstallationUntilServerDisconnectCompletes() = runBlocking {
        val disconnected = CompletableDeferred<Unit>()
        var installation: String? = "device-a"
        var signedIn = true
        val signOut = launch(start = CoroutineStart.UNDISPATCHED) {
            disconnectBeforeSignOut(installation, unregister = { id ->
                assertEquals("device-a", id); disconnected.await()
            }, finish = { signedIn = false; installation = null })
        }
        try {
            assertTrue(signedIn); assertEquals("device-a", installation)
            disconnected.complete(Unit); signOut.join()
            assertFalse(signedIn); assertEquals(null, installation)
        } finally { disconnected.complete(Unit); signOut.cancelAndJoin() }
    }

    @Test(timeout = 5000) fun failedDisconnectPreservesInstallationForRetry() = runBlocking {
        var installation: String? = "device-a"
        var signedIn = true
        var failed = false
        try {
            disconnectBeforeSignOut(installation, unregister = { throw IllegalStateException("offline") },
                finish = { signedIn = false; installation = null })
        } catch (_: IllegalStateException) { failed = true }
        assertTrue(failed); assertTrue(signedIn); assertEquals("device-a", installation)
    }

    @Test(timeout = 5000) fun deletedAccountAllowsLocalSignOut() = runBlocking {
        var installation: String? = "device-a"
        var signedIn = true
        disconnectBeforeSignOut(installation,
            unregister = { throw ApiFailure("account_deleted", 403) },
            finish = { signedIn = false; installation = null })
        assertFalse(signedIn); assertEquals(null, installation)
    }

    @Test(timeout = 5000) fun missingInstallationAllowsLocalSignOut() = runBlocking {
        var signedIn = true
        disconnectBeforeSignOut("device-a",
            unregister = { throw ApiFailure("device_not_found", 404) },
            finish = { signedIn = false })
        assertFalse(signedIn)
    }

    @Test(timeout = 5000) fun otherDisconnectRejectionsPreserveInstallationForRetry() = runBlocking {
        for (failure in listOf(ApiFailure("origin_not_allowed", 403), ApiFailure("account_deleted", 500),
            ApiFailure("invalid_owner_session", 401))) {
            var installation: String? = "device-a"
            var signedIn = true
            var received: ApiFailure? = null
            try {
                disconnectBeforeSignOut(installation, unregister = { throw failure },
                    finish = { signedIn = false; installation = null })
            } catch (e: ApiFailure) { received = e }
            assertTrue(received === failure); assertTrue(signedIn); assertEquals("device-a", installation)
        }
    }

    @Test(timeout = 5000) fun verifierRejectionAfterIdentityDeletionAllowsLocalSignOut() = runBlocking {
        val calls = mutableListOf<String>()
        var installation: String? = "device-a"
        var signedIn = true
        disconnectBeforeSignOut(installation,
            unregister = { calls += "disconnect"; throw ApiFailure("invalid_owner_session", 401) },
            sessionUnavailable = { failure ->
                unavailableSignOutSession(failure, { it is InvalidSession }, {
                    calls += "reload"; throw InvalidSession()
                })
            },
            finish = { calls += "finish"; signedIn = false; installation = null })
        assertEquals(listOf("disconnect", "reload", "finish"), calls)
        assertFalse(signedIn); assertEquals(null, installation)
    }

    @Test(timeout = 5000) fun verifierRejectionRetainsUsableSessionAndInstallation() = runBlocking {
        var finished = false
        var reloaded = false
        val failure = ApiFailure("invalid_owner_session", 401)
        var received: Exception? = null
        try {
            disconnectBeforeSignOut("device-a", unregister = { throw failure }, finish = { finished = true },
                sessionUnavailable = { unavailableSignOutSession(it, { it is InvalidSession }, { reloaded = true }) })
        } catch (e: Exception) { received = e }
        assertTrue(received === failure); assertTrue(reloaded); assertFalse(finished)
    }

    @Test(timeout = 5000) fun unavailableFirebaseDuringSessionCheckRetainsInstallation() = runBlocking {
        var finished = false
        val offline = java.io.IOException("Firebase unavailable")
        var received: Exception? = null
        try {
            disconnectBeforeSignOut("device-a", unregister = { throw ApiFailure("invalid_owner_session", 401) },
                finish = { finished = true },
                sessionUnavailable = { unavailableSignOutSession(it, { it is InvalidSession }, { throw offline }) })
        } catch (e: Exception) { received = e }
        assertTrue(received === offline); assertFalse(finished)
    }

    @Test(timeout = 5000) fun invalidSessionDuringTokenAcquisitionAllowsLocalSignOut() = runBlocking {
        var finished = false
        disconnectBeforeSignOut("device-a", unregister = { throw InvalidSession() }, finish = { finished = true },
            sessionUnavailable = { unavailableSignOutSession(it, { it is InvalidSession }, { error("No reload needed") }) })
        assertTrue(finished)
    }

    @Test fun invalidSessionCleanupPreservesAnyReplacementOwner() {
        for (current in listOf("owner-b", null)) {
            var finished = false
            var rejected = false
            try { finishSignOutForOwner("owner-a", current, sessionUnavailable = false) { finished = true } }
            catch (_: IllegalStateException) { rejected = true }
            assertTrue(rejected); assertFalse(finished)
        }
        var finished = false
        var rejected = false
        try { finishSignOutForOwner("owner-a", "owner-b", sessionUnavailable = true) { finished = true } }
        catch (_: IllegalStateException) { rejected = true }
        assertTrue(rejected); assertFalse(finished)
        finishSignOutForOwner("owner-a", null, sessionUnavailable = true) { finished = true }
        assertTrue(finished)
    }

    @Test(timeout = 5000) fun repeatedSignOutsDoNotAccumulateRegisteredDevices() = runBlocking {
        val active = mutableSetOf<String>()
        repeat(25) { cycle ->
            val installation = "device-$cycle"
            active += installation
            disconnectBeforeSignOut(installation, unregister = { active.remove(it) }, finish = {})
            assertTrue(active.isEmpty())
        }
    }
}
