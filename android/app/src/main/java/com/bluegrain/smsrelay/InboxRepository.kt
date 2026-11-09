package com.bluegrain.smsrelay

import android.content.Context
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject

// Definitions and response drafts stay in memory; only observation metadata enters WorkManager.
data class RequestForm(val id: String, val caller: String, val title: String, val body: String,
    val status: String, val expiresAt: Long, val fields: List<FormField>, val actions: List<FormAction>, val completedBy: String?, val helperDevices: Set<String> = emptySet(),
    val steps: List<FormStep> = emptyList()) {
    companion object {
        fun from(j: JSONObject) = RequestForm(j.getString("requestId"), j.getString("callerName"), j.getString("title"),
            j.optString("body"), j.getString("status"), j.getLong("expiresAt"),
            j.optJSONArray("fields")?.objects()?.map(FormField::from).orEmpty(), j.optJSONArray("actions")?.objects()?.map { FormAction(it.getString("id"), it.getString("label"), it.getString("type")) }.orEmpty(), j.nullString("completedByDeviceId"), j.optJSONObject("helpers")?.keys()?.asSequence()?.toSet().orEmpty(),
            j.optJSONArray("steps")?.objects()?.map { step ->
                val condition = step.optJSONObject("when")
                FormStep(step.getString("id"), step.getString("title"), step.optString("body"),
                    step.getJSONArray("fieldIds").let { ids -> (0 until ids.length()).map { ids.getString(it) } },
                    condition?.let { FormCondition(it.getString("fieldId"), if (it.has("equals")) it.get("equals") else null, it.nullString("contains")) })
            }.orEmpty())
    }
}
data class FormField(val id: String, val label: String, val type: String, val required: Boolean, val maxLength: Int,
    val min: Double?, val max: Double?, val options: List<Pair<String, String>>, val sms: Boolean) {
    companion object {
        fun from(j: JSONObject) = FormField(j.getString("id"), j.getString("label"), j.getString("type"), j.optBoolean("required"), j.optInt("maxLength", 1000),
            if (j.has("min")) j.getDouble("min") else null, if (j.has("max")) j.getDouble("max") else null,
            j.optJSONArray("options")?.objects()?.map { it.getString("id") to it.getString("label") }.orEmpty(), j.optString("input") == "sms_code")
    }
}
data class FormAction(val id: String, val label: String, val type: String)
fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }

fun reportObservation(context: Context, id: String, kind: String) {
    val app = context.applicationContext as RelayApplication
    if (!app.configured || !app.repository.signedIn) return
    val data = Data.Builder().putString("requestId", id).putString("type", kind)
        .putString("ownerId", app.repository.ownerId).putString("deviceId", app.repository.deviceId)
        .putLong("occurredAt", System.currentTimeMillis()).build()
    WorkManager.getInstance(context).enqueueUniqueWork("observation:${app.repository.ownerId}:$id:$kind", ExistingWorkPolicy.KEEP,
        OneTimeWorkRequestBuilder<ObservationWorker>().setInputData(data)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
}
class ObservationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as RelayApplication
        if (!app.configured) return Result.success()
        val repo = app.repository
        if (!repo.signedIn || repo.ownerId != inputData.getString("ownerId") || repo.deviceId != inputData.getString("deviceId")) return Result.success()
        return try {
            repo.formObservation(inputData.getString("requestId")!!, JSONObject().put("type", inputData.getString("type"))
                .put("occurredAt", inputData.getLong("occurredAt", 0)))
            Result.success()
        } catch (e: ApiFailure) { if (e.status == 429 || e.status >= 500) Result.retry() else Result.failure() }
        catch (_: Exception) { Result.retry() }
    }
}
