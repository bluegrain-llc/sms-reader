package com.bluegrain.smsrelay

import java.time.LocalDate

data class FormCondition(val fieldId: String, val equals: Any? = null, val contains: String? = null)
data class FormStep(val id: String, val title: String, val body: String, val fieldIds: List<String>, val condition: FormCondition? = null)

object FormWizard {
    fun stepFields(form: RequestForm, step: FormStep): List<FormField> = step.fieldIds.mapNotNull { id -> form.fields.find { it.id == id } }
    fun visibleSteps(form: RequestForm, values: Map<String, Any>): List<FormStep> {
        val available = mutableSetOf<String>()
        return form.steps.filter { step ->
            val c = step.condition
            val source = c?.let { condition -> form.fields.find { it.id == condition.fieldId } }
            val value = source?.let { normalized(it, values[it.id]) }
            val matches = c == null || (c.fieldId in available && if (c.contains != null) (value as? Set<*>)?.contains(c.contains) == true
                else if (value is Number && c.equals is Number) value.toDouble() == c.equals.toDouble() else value == c.equals)
            if (matches) available.addAll(step.fieldIds)
            matches
        }
    }
    fun fields(form: RequestForm, values: Map<String, Any>): List<FormField> {
        if (form.steps.isEmpty()) return form.fields
        val ids = visibleSteps(form, values).flatMap { it.fieldIds }.toSet()
        return form.fields.filter { it.id in ids }
    }
    fun prune(form: RequestForm, values: Map<String, Any>): Map<String, Any> {
        val ids = fields(form, values).map { it.id }.toSet()
        return values.filterKeys { it in ids }
    }
    fun current(form: RequestForm, values: Map<String, Any>, id: String?): FormStep? =
        visibleSteps(form, values).let { steps -> steps.find { it.id == id } ?: steps.firstOrNull() }
    fun normalized(field: FormField, value: Any?): Any? = when (field.type) {
        "number" -> (value as? String)?.toDoubleOrNull()?.takeIf { it.isFinite() } ?: (value as? Number)?.toDouble()
        "checkbox" -> value ?: false
        else -> value
    }
    fun errors(fields: List<FormField>, values: Map<String, Any>): Map<String, String> = buildMap {
        for (field in fields) {
            val raw = values[field.id]
            val v = normalized(field, raw)
            val missing = raw == null || raw == "" || raw is Set<*> && raw.isEmpty()
            val error = when {
                field.required && (missing || field.type == "checkbox" && v != true) -> "Required"
                missing -> null
                field.type == "number" && (v !is Double || !v.isFinite() || field.min != null && v < field.min || field.max != null && v > field.max) -> "Enter a number within the allowed range"
                field.type in listOf("text", "multiline") && (v !is String || v.length > field.maxLength) -> "Text is too long"
                field.sms && (v !is String || !CodeExtractor.validCode(v)) -> "Enter a valid code"
                field.type == "date" && (v !is String || !validDate(v)) -> "Choose a valid date"
                field.type == "single_choice" && field.options.none { it.first == v } -> "Choose an option"
                field.type == "multiple_choice" && (v !is Set<*> || v.any { id -> field.options.none { it.first == id } }) -> "Choose valid options"
                else -> null
            }
            if (error != null) put(field.id, error)
        }
    }
    private fun validDate(value: String) = try { LocalDate.parse(value).toString() == value } catch (_: Exception) { false }
    fun display(field: FormField, value: Any?): String = when (field.type) {
        "checkbox" -> if (value == true) "Yes" else "No"
        "single_choice" -> field.options.find { it.first == value }?.second ?: "Not provided"
        "multiple_choice" -> field.options.filter { (value as? Set<*>)?.contains(it.first) == true }.joinToString { it.second }.ifEmpty { "Not provided" }
        else -> value?.toString()?.ifEmpty { "Not provided" } ?: "Not provided"
    }
}
