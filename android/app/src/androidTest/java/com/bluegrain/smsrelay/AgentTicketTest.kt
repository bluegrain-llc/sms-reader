package com.bluegrain.smsrelay

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import java.util.UUID
import javax.crypto.KeyAgreement

class AgentTicketTest {
    @Test fun ticketUsesPortableMatchingP256KeysAndRetainsPrivateProvisioningState() {
        val ticket = AgentTicket.create("Synthetic agent", "Decisions", listOf("forms"))
        val key = ticket.getJSONArray("deliveryKeys").getJSONObject(0)
        val publicKey = key.getJSONObject("publicKey"); val privateKey = key.getJSONObject("privateKey")
        assertFalse(publicKey.has("d")); assertFalse(ticket.has("connections")); assertEquals(48, ticket.getString("serviceCredential").length)
        val canonical = "{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"${publicKey.getString("x")}\",\"y\":\"${publicKey.getString("y")}\"}"
        assertEquals(AgentTicket.digest(canonical), key.getString("id"))
        val remote = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val params = (remote.public as ECPublicKey).params
        fun scalar(value: String) = BigInteger(1, Base64.getUrlDecoder().decode(value))
        val factory = KeyFactory.getInstance("EC")
        val pub = factory.generatePublic(ECPublicKeySpec(ECPoint(scalar(publicKey.getString("x")), scalar(publicKey.getString("y"))), params))
        val priv = factory.generatePrivate(ECPrivateKeySpec(scalar(privateKey.getString("d")), params))
        val first = KeyAgreement.getInstance("ECDH").apply { init(priv); doPhase(remote.public, true) }.generateSecret()
        val second = KeyAgreement.getInstance("ECDH").apply { init(remote.private); doPhase(pub, true) }.generateSecret()
        assertArrayEquals(first, second)
        val context = ApplicationProvider.getApplicationContext<android.content.Context>(); val owner = "test-ticket-" + UUID.randomUUID()
        val storage = AgentTicket(context, owner)
        try {
            storage.save(ticket)
            assertEquals(ticket.toString(), storage.load()!!.toString())
            val retained = java.io.File(context.noBackupFilesDir, "ticket-${AgentTicket.digest(owner)}")
            assertTrue(retained.renameTo(java.io.File(retained.path + ".bak")))
            assertEquals(ticket.toString(), storage.load()!!.toString())
            val bytes = retained.readBytes()
            assertFalse(String(bytes, Charsets.ISO_8859_1).contains(ticket.getString("serviceCredential")))
        } finally { storage.clear(ticket.getString("serviceCredential")) }
    }
    @Test fun anotherCreationCannotReplaceAnUnsavedRetainedTicket() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val owner = "test-ticket-" + UUID.randomUUID()
        val storage = AgentTicket(context, owner)
        val retained = AgentTicket.create("Retained", "Decisions", listOf("forms"))
        try {
            storage.saveNew(retained)
            try {
                AgentTicket(context, owner).saveNew(AgentTicket.create("Other", "Decisions", listOf("forms")))
                fail("An unsaved private ticket must not be replaced")
            } catch (_: IllegalStateException) { }
            assertEquals(retained.toString(), storage.load()!!.toString())
        } finally { storage.clear(retained.getString("serviceCredential")) }
    }
    @Test fun staleClearCannotDeleteAnotherAgentsRetainedTicket() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val owner = "test-ticket-" + UUID.randomUUID()
        val stale = AgentTicket(context, owner); val current = AgentTicket(context, owner)
        val first = AgentTicket.create("First", "Decisions", listOf("forms"))
        val second = AgentTicket.create("Second", "Decisions", listOf("forms"))
        try {
            stale.saveNew(first)
            assertTrue(current.clear(first.getString("serviceCredential")))
            current.saveNew(second)
            assertFalse(stale.clear(first.getString("serviceCredential")))
            assertEquals(second.toString(), current.load()!!.toString())
            assertTrue(current.clear(second.getString("serviceCredential")))
            assertNull(current.load())
        } finally { current.load()?.let { current.clear(it.getString("serviceCredential")) } }
    }
    @Test fun deletedAccountClearsOnlyItsOwnRetainedTicket() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val owner = "test-ticket-" + UUID.randomUUID()
        val deleted = AgentTicket(context, owner); val other = AgentTicket(context, owner + "-other")
        val ticket = AgentTicket.create("Deleted owner", "Decisions", listOf("forms"))
        val otherTicket = AgentTicket.create("Other owner", "Decisions", listOf("forms"))
        try {
            deleted.saveNew(ticket); other.saveNew(otherTicket)
            deleted.clearForDeletedAccount()
            assertNull(deleted.load())
            assertEquals(otherTicket.toString(), other.load()!!.toString())
        } finally { deleted.clearForDeletedAccount(); other.clearForDeletedAccount() }
    }
}
