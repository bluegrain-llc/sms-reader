package com.bluegrain.smsrelay

import org.junit.Assert.*
import org.junit.Test

class FormWizardTest {
    private fun field(id: String, type: String = "text", required: Boolean = false) =
        FormField(id, id, type, required, 1000, null, null, emptyList(), false)
    private fun form() = RequestForm("wizard", "Bot", "Expense", "Review", "pending", 600_000,
        listOf(field("travel", "checkbox"), field("city", required = true), field("receipt", "checkbox"), field("reference", required = true)),
        listOf(FormAction("submit", "Submit", "submit")), null, steps = listOf(
            FormStep("kind", "Expense type", "", listOf("travel")),
            FormStep("trip", "Trip", "", listOf("city", "receipt"), FormCondition("travel", true)),
            FormStep("evidence", "Receipt", "", listOf("reference"), FormCondition("receipt", true))))
    @Test fun hiddenBranchesCannotActivateOtherBranchesOrRetainTheirAnswers() {
        val f = form()
        val values = mapOf<String, Any>("travel" to false, "city" to "Old city", "receipt" to true, "reference" to "Old receipt")
        assertEquals(listOf("kind"), FormWizard.visibleSteps(f, values).map { it.id })
        assertEquals(mapOf("travel" to false), FormWizard.prune(f, values))
        assertEquals(listOf("kind", "trip", "evidence"), FormWizard.visibleSteps(f, values + ("travel" to true)).map { it.id })
        assertEquals("kind", FormWizard.current(f, values, "evidence")?.id)
        assertEquals(listOf("receipt", "city"), FormWizard.stepFields(f, f.steps[1].copy(fieldIds = listOf("receipt", "city"))).map { it.id })
    }
    @Test fun nextValidatesOnlyTheCurrentStepAndFinalReviewValidatesAllVisibleFields() {
        val f = form(); val values = mapOf<String, Any>("travel" to true)
        assertTrue(FormWizard.errors(f.fields.take(1), values).isEmpty())
        assertEquals(mapOf("city" to "Required"), FormWizard.errors(FormWizard.fields(f, values), values))
        assertTrue(FormWizard.errors(FormWizard.fields(f, values), values + ("city" to "Santo Domingo")).isEmpty())
    }
    @Test fun predicatesNormalizeNumbersButDoNotMatchHiddenSourcesAndSupportMultipleChoices() {
        val f = form().copy(fields = listOf(field("tags", "multiple_choice"), field("amount", "number"), field("note")), steps = listOf(
            FormStep("tags", "Tags", "", listOf("tags")),
            FormStep("amount", "Amount", "", listOf("amount"), FormCondition("tags", contains = "tax")),
            FormStep("note", "Note", "", listOf("note"), FormCondition("amount", 10))))
        assertEquals(listOf("tags", "amount", "note"), FormWizard.visibleSteps(f, mapOf("tags" to setOf("tax"), "amount" to "10.0")).map { it.id })
        assertEquals(listOf("tags"), FormWizard.visibleSteps(f, mapOf("tags" to emptySet<String>(), "amount" to "10")).map { it.id })
        assertEquals(listOf("tags", "amount"), FormWizard.visibleSteps(f, mapOf("tags" to setOf("tax"), "amount" to "invalid")).map { it.id })
    }
    @Test fun fieldValidationHandlesBoundsCodesCheckboxesAndDatesBeforeNext() {
        val fields = listOf(field("amount", "number", true).copy(min = 1.0, max = 5.0), field("accept", "checkbox", true),
            field("code").copy(sms = true), field("date", "date"))
        val invalid = mapOf<String, Any>("amount" to "6", "accept" to false, "code" to "letters", "date" to "2026-02-30")
        assertEquals(setOf("amount", "accept", "code", "date"), FormWizard.errors(fields, invalid).keys)
        assertTrue(FormWizard.errors(fields, mapOf("amount" to "4.5", "accept" to true, "code" to "0000", "date" to "2026-11-09")).isEmpty())
        assertEquals(setOf("amount", "accept"), FormWizard.errors(fields, emptyMap()).keys)
    }
    @Test fun reviewUsesHumanLabelsAndUntouchedCheckboxDefaultsMatchServer() {
        val choice = field("category", "single_choice").copy(options = listOf("food" to "Meals"))
        assertEquals("Meals", FormWizard.display(choice, "food"))
        assertEquals("No", FormWizard.display(field("travel", "checkbox"), null))
        assertEquals("Not provided", FormWizard.display(choice, null))
        val f = form().copy(steps = listOf(form().steps[0], form().steps[1].copy(condition = FormCondition("travel", false))))
        assertEquals(listOf("kind", "trip"), FormWizard.visibleSteps(f, emptyMap()).map { it.id })
    }
}
