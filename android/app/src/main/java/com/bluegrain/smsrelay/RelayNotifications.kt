package com.bluegrain.smsrelay

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

object RelayNotifications {
    const val CHANNEL = "code_requests"
    val validId = Regex("^[a-f0-9]{64}$")
    fun createChannel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Requests", NotificationManager.IMPORTANCE_HIGH)
                .apply { description = "Information, decisions and SMS code requests" })
    }
    fun enabled(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        context.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
    fun show(context: Context, id: String, consent: Boolean = false, kind: String? = null) {
        if (!validId.matches(id) || !enabled(context)) return
        val prefs = context.getSharedPreferences("notification_dedupe", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!consent && prefs.getLong(id, 0) > now - 10 * 60_000) return
        // Bound persistent dedupe data; FCM and notification retries use the same request ID.
        prefs.edit(commit = true) {
            prefs.all.filterValues { it is Long && it < now - 10 * 60_000 }.keys.forEach { remove(it) }
            putLong(id, now)
        }
        val tap = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java)
            .setData("smsrelay://request/$id".toUri()).putExtra("requestId", id).putExtra("kind", kind).putExtra("notificationTap", true), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(com.bluegrain.smsrelay.R.drawable.ic_relay)
            .setContentTitle(if (consent) "Review your SMS approval" else if (kind == "form") "A response has been requested" else "A code has been requested")
            .setContentText("Open Inbox to respond.").setContentIntent(tap)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setAutoCancel(true).setOnlyAlertOnce(true)
            .setTimeoutAfter(if (kind == "form") 24 * 60 * 60_000L else 10 * 60_000L).build()
        try { NotificationManagerCompat.from(context).notify(id, 1, notification) }
        catch (_: SecurityException) {
            // Permission can be revoked between the eligibility check and posting.
            WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<RegistrationWorker>()
                .setInputData(Data.Builder().putString("requestId", id).build()).build())
        }
    }
    fun dismiss(context: Context, id: String) { NotificationManagerCompat.from(context).cancel(id, 1) }
}
class RelayMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val id = message.data["requestId"] ?: return
        if (!RelayNotifications.validId.matches(id)) return
        if (RelayNotifications.enabled(this)) RelayNotifications.show(this, id, kind = message.data["kind"])
        else if (message.data["kind"] != "form") enqueue(id)
    }
    override fun onNewToken(token: String) { enqueue(null) }
    private fun enqueue(requestId: String?) {
        val data = Data.Builder().apply { requestId?.let { putString("requestId", it) } }.build()
        WorkManager.getInstance(this).enqueue(OneTimeWorkRequestBuilder<RegistrationWorker>().setInputData(data).build())
    }
}
class RegistrationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as RelayApplication
        if (!app.configured) return Result.success()
        val repo = app.repository
        if (!repo.signedIn || !repo.registered) return Result.success()
        return try {
            repo.register()
            inputData.getString("requestId")?.let { repo.event(it, "failed", reason = "notifications_disabled") }
            Result.success()
        } catch (e: ApiFailure) {
            if (e.status < 500) Result.failure() else Result.retry()
        } catch (_: Exception) { Result.retry() }
    }
}
