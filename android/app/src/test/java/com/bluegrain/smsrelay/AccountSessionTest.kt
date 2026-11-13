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
