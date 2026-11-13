package com.bluegrain.smsrelay

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Retains provisioning state across network and document-provider failures. Never backed up. */
class AgentTicket(private val context: Context, ownerId: String) {
    private val file = AtomicFile(java.io.File(context.noBackupFilesDir, "ticket-${digest(ownerId)}"))
    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return store.getKey("agent-ticket-storage", null) as? SecretKey ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder("agent-ticket-storage", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    fun load(): JSONObject? {
        // openRead recovers AtomicFile's backup after interrupted replacement, including on API 26.
        val bytes = try { file.openRead().use { it.readBytes() } } catch (_: java.io.FileNotFoundException) { return null }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }
    fun save(ticket: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secret()) }
        val stream = file.startWrite()
        try { stream.write(cipher.iv + cipher.doFinal(ticket.toString().toByteArray(Charsets.UTF_8))); file.finishWrite(stream) }
        catch (e: Exception) { file.failWrite(stream); throw e }
    }
    fun saveNew(ticket: JSONObject) = synchronized(retentionLock) {
        check(load() == null) { "Save or clear the retained ticket before creating another agent." }
        save(ticket)
    }
    fun loadForExport(expectedCredential: String): JSONObject = synchronized(retentionLock) {
        val retained = load() ?: error("ticket_missing")
        check(retained.getString("serviceCredential") == expectedCredential) { "ticket_changed" }
        retained
    }
    fun clear(expectedCredential: String): Boolean = synchronized(retentionLock) {
        val retained = load()
        if (retained == null) true
        else if (retained.getString("serviceCredential") != expectedCredential) false
        else { file.delete(); true }
    }
    fun clearForDeletedAccount() = synchronized(retentionLock) { file.delete() }
    companion object {
        private val retentionLock = Any()
        private fun encode(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        private fun coordinate(n: BigInteger) = n.toByteArray().let { if (it.size > 32) it.takeLast(32).toByteArray() else ByteArray(32 - it.size) + it }
        fun create(name: String, purpose: String, capabilities: List<String>): JSONObject {
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            val pub = pair.public as ECPublicKey
            val publicKey = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", encode(coordinate(pub.w.affineX))).put("y", encode(coordinate(pub.w.affineY)))
            val privateKey = JSONObject(publicKey.toString()).put("d", encode(coordinate((pair.private as ECPrivateKey).s)))
            // Explicit ordering matches the relay and portable ticket format, independent of JSONObject ordering.
            val canonical = "{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"${publicKey.getString("x")}\",\"y\":\"${publicKey.getString("y")}\"}"
            return JSONObject().put("version", 1).put("relayOrigin", BuildConfig.RELAY_URL.trimEnd('/'))
                .put("agent", JSONObject().put("name", name).put("purpose", purpose).put("capabilities", JSONArray(capabilities)))
                .put("serviceCredential", "smss_" + encode(ByteArray(32).also { SecureRandom().nextBytes(it) }))
                .put("deliveryKeys", JSONArray().put(JSONObject().put("id", digest(canonical)).put("publicKey", publicKey).put("privateKey", privateKey)))
        }
        fun declaration(ticket: JSONObject) = JSONObject(ticket.getJSONObject("agent").toString())
            .put("credentialHash", digest(ticket.getString("serviceCredential")))
            .put("deliveryPublicKey", ticket.getJSONArray("deliveryKeys").getJSONObject(0).getJSONObject("publicKey"))
    }
}
