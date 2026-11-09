package com.bluegrain.smsrelay

import android.content.Context
import android.os.Build
import androidx.core.content.edit
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

class ApiFailure(val reason: String, val status: Int) : IOException(reason)
data class PhoneRequest(val id: String, val status: String, val caller: String, val purpose: String,
    val sender: String?, val expiresAt: Long, val listeningDeadline: Long?, val reason: String?, val title: String = "Verification code") {
    val active get() = status in setOf("pending_phone", "ready", "awaiting_consent")
    companion object {
        fun from(j: JSONObject) = PhoneRequest(j.getString("requestId"), j.getString("status"),
            j.optString("callerName"), j.optString("purpose"), j.nullString("senderPhone"),
            j.getLong("expiresAt"), if (j.isNull("listeningDeadline")) null else j.getLong("listeningDeadline"), j.nullString("reason"), j.optString("title", "Verification code"))
    }
}
fun JSONObject.nullString(key: String): String? = if (isNull(key)) null else optString(key).ifBlank { null }
data class ConnectionReview(val code: String, val caller: String, val purpose: String, val status: String,
    val expiresAt: Long, val days: Int) {
    companion object {
        fun from(j: JSONObject) = ConnectionReview(j.getString("userCode"), j.getString("callerName"), j.getString("purpose"),
            j.getString("status"), j.getLong("expiresAt"), j.getInt("expiresInDays"))
    }
}
class RelayRepository(context: Context) {
    private val prefs = context.getSharedPreferences("installation", Context.MODE_PRIVATE)
    private val auth get() = FirebaseAuth.getInstance()
    private val client = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()
    val signedIn get() = auth.currentUser != null
    val email get() = auth.currentUser?.email.orEmpty()
    val deviceId: String get() = prefs.getString("id", null) ?: UUID.randomUUID().toString().also { prefs.edit(commit = true) { putString("id", it) } }
    var registered: Boolean
        get() = prefs.getBoolean("registered", false)
        set(v) { prefs.edit(commit = true) { putBoolean("registered", v) } }
    var autoConnect: Boolean
        get() = prefs.getBoolean("autoConnect", true)
        set(v) { prefs.edit(commit = true) { putBoolean("autoConnect", v) } }
    // Commit these tiny metadata-only markers before starting the platform listener.
    var inFlight: String?
        get() = prefs.getString("inFlight", null)
        set(v) { prefs.edit(commit = true) { putString("inFlight", v) } }
    var listenerUntil: Long
        get() = prefs.getLong("listenerUntil", 0)
        set(v) { prefs.edit(commit = true) { putLong("listenerUntil", v) } }
    suspend fun signIn(idToken: String) {
        val credential = GoogleAuthProvider.getCredential(idToken, null)
        val current = auth.currentUser
        if (current == null) auth.signInWithCredential(credential).await()
        else current.reauthenticate(credential).await()
    }
    private suspend fun call(method: String, path: String, body: JSONObject? = null): String {
        val token = auth.currentUser?.getIdToken(false)?.await()?.token ?: throw ApiFailure("sign_in_required", 401)
        return withContext(Dispatchers.IO) {
            val payload = if (method in listOf("POST", "PUT", "PATCH")) (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()) else null
            val request = Request.Builder().url(BuildConfig.RELAY_URL.trimEnd('/') + path)
                .header("Authorization", "Bearer $token").method(method, payload).build()
            client.newCall(request).execute().use { response ->
                val data = response.body?.string().orEmpty()
                if (!response.isSuccessful) throw ApiFailure(runCatching { JSONObject(data).optString("error", "server_error") }.getOrDefault("server_error"), response.code)
                data
            }
        }
    }
    suspend fun register(): JSONObject {
        val fcm = FirebaseMessaging.getInstance().token.await()
        val r = JSONObject(call("PUT", "/v1/devices/$deviceId", JSONObject().put("name", "${Build.MANUFACTURER} ${Build.MODEL}").put("fcmToken", fcm)))
        registered = true
        autoConnect = true
        return r
    }
    suspend fun devices() = JSONArray(call("GET", "/v1/devices"))
    suspend fun grants() = JSONArray(call("GET", "/v1/callers"))
    suspend fun reviewConnection(code: String) = ConnectionReview.from(JSONObject(call("POST", "/v1/connections/review", JSONObject().put("userCode", code))))
    suspend fun decideConnection(code: String, approved: Boolean) = ConnectionReview.from(JSONObject(call("POST", "/v1/connections/decision",
        JSONObject().put("userCode", code).put("decision", if (approved) "approved" else "denied"))))
    suspend fun history() = JSONArray(call("GET", "/v1/history"))
    suspend fun revoke(id: String) { call("DELETE", "/v1/grants/$id") }
    suspend fun pause(paused: Boolean, id: String = deviceId) { call("PATCH", "/v1/devices/$id", JSONObject().put("paused", paused)) }
    suspend fun request(id: String) = PhoneRequest.from(JSONObject(call("GET", "/v1/devices/$deviceId/requests/$id")))
    suspend fun event(id: String, status: String, reason: String? = null, code: String? = null, startedAt: Long? = null, source: String? = null): JSONObject {
        val b = JSONObject().put("status", status)
        reason?.let { b.put("reason", it) }; code?.let { b.put("code", it) }; startedAt?.let { b.put("listenerStartedAt", it) }; source?.let { b.put("source", it) }
        return JSONObject(call("POST", "/v1/devices/$deviceId/requests/$id/events", b))
    }
    suspend fun unregister(id: String = deviceId) { call("DELETE", "/v1/devices/$id"); if (id == deviceId) { reset(); autoConnect = false } }
    suspend fun deleteAccount() { call("DELETE", "/v1/account"); auth.signOut(); reset() }
    private fun reset() {
        val previousListenerDeadline = listenerUntil
        prefs.edit(commit = true) { clear(); putLong("listenerUntil", previousListenerDeadline) }
    }
}
