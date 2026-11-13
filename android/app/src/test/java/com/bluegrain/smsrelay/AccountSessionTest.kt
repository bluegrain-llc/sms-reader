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
