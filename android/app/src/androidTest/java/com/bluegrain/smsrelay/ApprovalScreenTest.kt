package com.bluegrain.smsrelay

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.graphics.asAndroidBitmap
import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.After
import androidx.compose.runtime.collectAsState
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse

class ApprovalScreenTest {
    @get:Rule val compose = createComposeRule()
    @Test fun focusedRequestRendersMarkdownAndCandidateSelectionSubmitsOnce() {
        var selected: String? = null
        var ui by androidx.compose.runtime.mutableStateOf(RelayUiState(configured = true, signedIn = true, registered = true,
            request = PhoneRequest("request", "awaiting_consent", "My assistant", "## Bizee verification\n\nEnter the **verification code** to finish signing in.", null, 600_000, 300_000, null, "Sign in"),
            candidates = listOf("123456", "654321"), now = 0))
        compose.setContent {
            RelayTheme { SmsScreen(ui,
                onSelectCandidate = { id, code -> assertEquals("request", id); ui = ui.copy(codeDraft = code); selected = code },
                onSubmitCode = { id -> assertEquals("request", id); selected = ui.codeDraft }) }
        }
        compose.onNodeWithText("My assistant — Sign in").assertIsDisplayed()
        compose.onNodeWithText("Bizee verification").assertIsDisplayed()
        compose.onNodeWithText("Enter the verification code to finish signing in.").assertIsDisplayed()
        compose.onNodeWithText("Relay").assertDoesNotExist()
        compose.onNodeWithText("Admin").assertDoesNotExist()
        compose.onNodeWithText("Send").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Send 654321").performScrollTo().performClick()
        assertEquals("654321", selected)
        compose.onNodeWithText("Close").performScrollTo()
        compose.mainClock.advanceTimeBy(500)
        val preview = compose.onRoot().captureToImage().asAndroidBitmap()
        File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "sms-request-preview.png")
            .outputStream().use { preview.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun cancelRemainsAvailableDuringUpload() {
        var cancelled = false
        compose.setContent {
            RelayTheme {
                SmsScreen(RelayUiState(configured = true, signedIn = true, registered = true, busy = true,
                    request = PhoneRequest("request", "awaiting_consent", "My assistant", "Test", null, 600_000, 300_000, null),
                    codeDraft = "123456", now = 0), onCancel = { cancelled = true })
            }
        }
        compose.onNodeWithText("Please wait…").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Cancel request").performScrollTo().assertIsEnabled().performClick()
        assertEquals(true, cancelled)
    }
    @Test fun manualEntryNeedsValidCodeAndExplicitSend() {
        var sent = false
        var ui by androidx.compose.runtime.mutableStateOf(RelayUiState(configured = true, signedIn = true, registered = true,
            request = PhoneRequest("manual-request", "ready", "Invoice bot", "- Enter your code\n- Tap **Send**", null, 600_000, 300_000, null, "Verify login"), now = 0,
            autofillDeclined = true))
        compose.setContent { RelayTheme { SmsScreen(ui,
            onCodeChange = { id, value -> assertEquals("manual-request", id); ui = ui.copy(codeDraft = value) },
            onSubmitCode = { id -> assertEquals("manual-request", id); sent = true }) } }
        compose.onNodeWithText("SMS code").performScrollTo().performTextInput("ABC")
        compose.onNodeWithText("Send").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("SMS code").performScrollTo().performTextReplacement("A12b34")
        assertEquals(false, sent)
        compose.onNodeWithText("Send").performScrollTo().assertIsEnabled().performClick()
        assertEquals(true, sent)
    }
    @Test fun manualDraftWaitsForSendAndExpiryDisablesIt() {
        var sent = false
        var ui by androidx.compose.runtime.mutableStateOf(RelayUiState(configured = true, signedIn = true, registered = true,
            request = PhoneRequest("request", "awaiting_consent", "Invoice bot", "Enter your verification code.", null, 600_000, 300_000, null),
            codeDraft = "123456", now = 0))
        compose.setContent { RelayTheme { SmsScreen(ui, onSubmitCode = { sent = true }) } }
        compose.onNodeWithText("Send").performScrollTo().assertIsEnabled()
        assertEquals(false, sent)
        compose.runOnIdle { ui = ui.copy(now = 300_001) }
        compose.onNodeWithText("Send").assertIsNotEnabled()
        assertEquals(false, sent)
    }

    @Test fun onlyConfirmedSendOnThisPhoneClosesTheRequest() {
        var closed = 0
        val request = PhoneRequest("request", "awaiting_consent", "Invoice bot", "Enter your code", null, 600_000, 300_000, null)
        var ui by androidx.compose.runtime.mutableStateOf(RelayUiState(configured = true, signedIn = true, registered = true,
            request = request, codeDraft = "123456", now = 0))
        compose.setContent { RelayTheme { SmsScreen(ui, onRequestSent = { closed++ }) } }
        compose.runOnIdle { assertEquals(0, closed); ui = ui.copy(request = request.copy(status = "failed")) }
        compose.runOnIdle { assertEquals(0, closed); ui = ui.copy(request = request.copy(status = "completed", reason = "handled_on_another_device")) }
        compose.runOnIdle { assertEquals(0, closed); ui = ui.copy(request = request.copy(status = "completed")) }
        compose.waitUntil { closed == 1 }
        compose.onNodeWithText("Close").assertDoesNotExist()
        compose.runOnIdle { ui = ui.copy(now = 1000) }
        compose.runOnIdle { assertEquals(1, closed) }
    }

    @Test fun relayHidesCredentialSetupAndAdminListsAllPhones() {
        compose.setContent {
            RelayTheme {
                HomeScreen(RelayUiState(configured = true, signedIn = true, registered = true,
                    email = "owner@example.test", devices = listOf(
                        DeviceRow("first", "Samsung phone", false, true),
                        DeviceRow("second", "Pixel phone", true, false))),
                    )
            }
        }
        compose.onNodeWithText("No pending requests.").assertIsDisplayed()
        compose.onNodeWithText("Connect an app or bot").assertDoesNotExist()
        compose.onNodeWithText("Settings").performClick()
        compose.onNodeWithText("Connect an app or bot").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Copy connection").assertDoesNotExist()
        compose.mainClock.advanceTimeBy(500)
        val preview = compose.onRoot().captureToImage().asAndroidBitmap()
        File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "admin-preview.png")
            .outputStream().use { preview.compress(Bitmap.CompressFormat.PNG, 100, it) }
        compose.onNodeWithText("Devices").performClick()
        compose.onNodeWithText("Samsung phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("This phone · Receives requests").assertIsDisplayed()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("Pixel phone"))
        compose.onNodeWithText("Pixel phone").assertIsDisplayed()
    }
    @Test fun anotherPhonesApprovalIsClearlyReportedWithoutTheCode() {
        compose.setContent {
            RelayTheme {
                SmsScreen(RelayUiState(configured = true, signedIn = true, registered = true,
                    request = PhoneRequest("request", "completed", "My assistant", "Sign in", null,
                        600_000, 300_000, "handled_on_another_device")),
                    )
            }
        }
        compose.onNodeWithText("Handled on another phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("SMS code").assertDoesNotExist()
        compose.onNodeWithText("Admin").assertDoesNotExist()
        compose.onNodeWithText("Close").performScrollTo().assertIsDisplayed()
    }
    @Test fun openingConnectionRequiresAnExplicitOwnerDecision() {
        var decision: Boolean? = null
        compose.setContent {
            RelayTheme {
                SettingsTestScreen(RelayUiState(configured = true, signedIn = true, registered = true,
                    email = "owner@example.test", now = 0,
                    connection = ConnectionReview("ABCDE-FG234", "Invoice bot", "Receive sign-in codes", "pending", 600_000, 30)),
                    onConnectionDecision = { code, approved -> assertEquals("ABCDE-FG234", code); decision = approved })
            }
        }
        compose.onNodeWithText("Invoice bot").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("ABCDE-FG234").assertIsDisplayed()
        assertEquals(null, decision)
        compose.mainClock.advanceTimeBy(500)
        val preview = compose.onRoot().captureToImage().asAndroidBitmap()
        File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "connection-preview.png")
            .outputStream().use { preview.compress(Bitmap.CompressFormat.PNG, 100, it) }
        compose.onNodeWithText("Approve connection").performScrollTo().performClick()
        assertEquals(true, decision)
    }
    @Test fun expiredConnectionCannotBeApproved() {
        compose.setContent {
            RelayTheme {
                SettingsTestScreen(RelayUiState(configured = true, signedIn = true, registered = true, now = 600_000,
                    connection = ConnectionReview("ABCDE-FG234", "Expired bot", "Sign in", "pending", 600_000, 30)))
            }
        }
        compose.onNodeWithText("Connection expired. Ask the app for a new link.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Approve connection").assertDoesNotExist()
    }
    @Test fun failedConnectionLookupKeepsItsCodeForRetryWithoutAnApprovalButton() {
        var retried: String? = null
        compose.setContent {
            RelayTheme {
                SettingsTestScreen(RelayUiState(configured = true, signedIn = true, registered = true,
                    connectionCode = "ABCDE-FG234", error = "Check your network and retry."),
                    onReviewConnection = { retried = it })
            }
        }
        compose.onNodeWithText("ABCDE-FG234").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Approve connection").assertDoesNotExist()
        compose.onNodeWithText("Review connection").performScrollTo().performClick()
        assertEquals("ABCDE-FG234", retried)
    }
    @androidx.compose.runtime.Composable
    private fun SmsScreen(state: RelayUiState,
        onSelectCandidate: (String, String) -> Unit = { _, _ -> }, onSubmitCode: (String) -> Unit = {},
        onCodeChange: (String, String) -> Unit = { _, _ -> }, onCancel: () -> Unit = {}, onRequestSent: () -> Unit = {}) {
        RelayScreen(state, RelayDestination.Response(RequestTarget(state.request!!.id, RequestKind.Sms), RequestOrigin.Inbox),
            responseReady = true, onSelectCandidate = onSelectCandidate, onSubmitCode = onSubmitCode,
            onCodeChange = onCodeChange, onCancel = onCancel, onRequestSent = onRequestSent)
    }
    @androidx.compose.runtime.Composable
    private fun SettingsTestScreen(state: RelayUiState, onConnectionDecision: (String, Boolean) -> Unit = { _, _ -> }, onReviewConnection: (String) -> Unit = {}) {
        SettingsScreen(state, SettingsSection.Access, onConnectionDecision = onConnectionDecision, onReviewConnection = onReviewConnection)
    }
    @androidx.compose.runtime.Composable
    private fun HomeScreen(state: RelayUiState, formState: InboxState = InboxState(),
        onOpenForm: (String) -> Unit = {}, onApproveForms: (String, Boolean) -> Unit = { _, _ -> }) {
        var destination by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf<RelayDestination>(RelayDestination.Inbox) }
        RelayScreen(state, destination, formState, onSettings = { destination = RelayDestination.Settings() },
            onSection = { destination = RelayDestination.Settings(it) }, onBack = { destination = RelayDestination.Inbox },
            onOpenForm = onOpenForm, onApproveForms = onApproveForms)
    }
    private fun form() = RequestForm("form-1", "Expense assistant", "Review invoice", "## Invoice details\n\nChoose a category and approve.",
        "pending", 600_000, listOf(
            FormField("note", "Comment", "multiline", true, 1000, null, null, emptyList(), false),
            FormField("category", "Category", "single_choice", true, 1000, null, null, listOf("food" to "Meals", "travel" to "Travel"), false),
            FormField("code", "Verification code", "text", false, 10, null, null, emptyList(), true)),
        listOf(FormAction("approve", "Approve invoice", "approve"), FormAction("decline", "Decline invoice", "decline")), null)

    @Test fun generalFormNeedsExplicitSubmissionAfterManualEntryOrAutofill() {
        var submissions = 0
        var listened = false
        var ui by androidx.compose.runtime.mutableStateOf(InboxState(form = form(), now = 0, foreground = true))
        compose.setContent { RelayTheme { RequestFormScreen(ui, "phone", {},
            { id, value -> ui = ui.copy(values = ui.values + (id to value)) }, { submissions++ }, {}, { listened = true }, {}) } }
        compose.onNodeWithText("Invoice details").assertIsDisplayed()
        compose.onNodeWithText("Comment *").performScrollTo().performTextInput("Business lunch")
        compose.onNodeWithText("Meals").performScrollTo().performClick()
        compose.onNodeWithText("Autofill from an upcoming SMS").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(true, listened); assertEquals(0, submissions); ui = ui.copy(values = ui.values + ("code" to "123456")) }
        compose.onNodeWithText("Approve invoice").performScrollTo().performClick()
        assertEquals(1, submissions)
        assertEquals("Business lunch", ui.values["note"])
        assertEquals("food", ui.values["category"])
    }
    @Test fun formBackLeavesPendingAndOpeningRequiresForegroundRendering() {
        var backs = 0
        var opens = 0
        var submissions = 0
        var ui by androidx.compose.runtime.mutableStateOf(InboxState(form = form(), now = 0))
        compose.setContent { RelayTheme { RequestFormScreen(ui, "phone", { backs++ }, { _, _ -> }, { submissions++ }, { opens++ }, {}, {}) } }
        compose.runOnIdle { assertEquals(0, opens); ui = ui.copy(foreground = true) }
        compose.waitUntil { opens == 1 }
        compose.onNodeWithText("Close").performScrollTo().performClick()
        assertEquals(1, backs); assertEquals(0, submissions); assertEquals("pending", ui.form?.status)
    }
    @Test fun generalFormExpiryDisablesActionsAndReportsCompetingPhone() {
        var ui by androidx.compose.runtime.mutableStateOf(InboxState(form = form(), now = 600_001))
        compose.setContent { RelayTheme { RequestFormScreen(ui, "phone", {}, { _, _ -> }, {}, {}, {}, {}) } }
        compose.onNodeWithText("This request has expired.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Approve invoice").assertDoesNotExist()
        compose.runOnIdle { ui = ui.copy(form = form().copy(status = "submitted", completedBy = "other-phone")) }
        compose.onNodeWithText("Answered on another phone.").performScrollTo().assertIsDisplayed()
    }
    @Test fun inboxRemainsAvailableWhileSmsIsListeningAndFormPermissionIsExplicit() {
        var opened: String? = null
        var approved = false
        compose.setContent { RelayTheme { HomeScreen(RelayUiState(configured = true, signedIn = true, registered = true,
            request = PhoneRequest("sms", "ready", "SMS bot", "SMS", null, 600_000, 300_000, null), now = 0,
            grants = listOf(GrantRow("grant", "Expense assistant", false, 600_000))),
            formState = InboxState(requests = listOf(form())), onOpenForm = { opened = it }, onApproveForms = { _, value -> approved = value }) } }
        compose.onNodeWithText("SMS bot").assertIsDisplayed()
        compose.onNodeWithText("Review invoice").performScrollTo().performClick()
        assertEquals("form-1", opened)
        compose.onNodeWithText("Settings").performClick()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("SMS requests only"))
        compose.onNodeWithText("SMS requests only").assertIsDisplayed()
        compose.onNodeWithText("Allow interactive requests").performScrollTo().performClick()
        assertEquals(true, approved)
    }

    @Test fun formRendersNumberCheckboxMultipleChoiceAndNativeDateControl() {
        val fields = listOf(
            FormField("amount", "Amount", "number", true, 1000, 1.0, 100.0, emptyList(), false),
            FormField("confirmed", "Confirmed", "checkbox", true, 1000, null, null, emptyList(), false),
            FormField("tags", "Tags", "multiple_choice", false, 1000, null, null, listOf("tax" to "Tax", "work" to "Work"), false),
            FormField("date", "Invoice date", "date", false, 1000, null, null, emptyList(), false))
        var ui by androidx.compose.runtime.mutableStateOf(InboxState(form = form().copy(fields = fields), now = 0))
        compose.setContent { RelayTheme { RequestFormScreen(ui, "phone", {}, { id, value -> ui = ui.copy(values = ui.values + (id to value)) }, {}, {}, {}, {}) } }
        compose.onNodeWithText("Amount *").performScrollTo().performTextInput("42.50")
        compose.onNodeWithText("Confirmed *").performScrollTo().performClick()
        compose.onNodeWithText("Tax").performScrollTo().performClick()
        compose.onNodeWithText("Work").performScrollTo().performClick()
        compose.onNodeWithText("Choose a date").performScrollTo().assertIsEnabled()
        assertEquals("42.50", ui.values["amount"])
        assertEquals(true, ui.values["confirmed"])
        assertEquals(setOf("tax", "work"), ui.values["tags"])
    }

    private val wizardStores = mutableListOf<ViewModelStore>()
    @After fun clearWizardViewModels() { wizardStores.forEach { it.clear() } }
    private fun wizardVm(): InboxViewModel {
        val vm = InboxViewModel(InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as RelayApplication)
        ViewModelStore().also { it.put("wizard", vm); wizardStores.add(it) }
        return vm
    }
    private fun wizardForm() = form().copy(id = "wizard-1", expiresAt = System.currentTimeMillis() + 600_000,
        fields = listOf(form().fields[1], form().fields[0], FormField("confirmed", "Confirmed", "checkbox", true, 1000, null, null, emptyList(), false)),
        steps = listOf(FormStep("kind", "Expense type", "Choose the expense type.", listOf("category")),
            FormStep("trip", "Travel details", "Describe the trip.", listOf("note"), FormCondition("category", "travel")),
            FormStep("finish", "Confirmation", "", listOf("confirmed"))))

    @Test fun wizardValidatesStepsReviewsOnceAndPrunesChangedBranches() {
        val vm = wizardVm()
        var submissions = 0
        compose.runOnIdle { vm.showLoaded(wizardForm()) }
        compose.setContent { val s by vm.state.collectAsState(); RelayTheme {
            RequestFormScreen(s, "phone", vm::close, vm::change, { submissions++ }, {}, {}, {}, vm::next, vm::previous)
        } }
        compose.onNodeWithText("Step 1 of 2").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Approve invoice").assertDoesNotExist()
        compose.onNodeWithText("Decline invoice").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Next").performScrollTo().performClick()
        compose.onNodeWithText("Required").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Travel").performScrollTo().performClick()
        compose.onNodeWithText("Next").performScrollTo().performClick()
        compose.onNodeWithText("Step 2 of 3").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Comment *").performScrollTo().performTextInput("Flight to Santo Domingo")
        compose.onNodeWithText("Next").performScrollTo().performClick()
        compose.onNodeWithText("Confirmed *").performScrollTo().performClick()
        compose.onNodeWithText("Review response").performScrollTo().performClick()
        compose.onNodeWithText("Review your response").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Flight to Santo Domingo").performScrollTo().assertIsDisplayed()
        assertEquals(0, submissions)
        repeat(3) { compose.onNodeWithText("Previous step").performScrollTo().performClick() }
        compose.onNodeWithText("Meals").performScrollTo().performClick()
        compose.onNodeWithText("Next").performScrollTo().performClick()
        compose.onNodeWithText("Step 2 of 2").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Review response").performScrollTo().performClick()
        compose.onNodeWithText("Flight to Santo Domingo").assertDoesNotExist()
        compose.runOnIdle { assertFalse(vm.state.value.values.containsKey("note")) }
        compose.onNodeWithText("Approve invoice").performScrollTo().performClick()
        assertEquals(1, submissions)
    }
    @Test fun wizardDraftsResumeFromInboxAndStayIsolatedBetweenRequests() {
        val vm = wizardVm(); val first = wizardForm(); val second = first.copy(id = "wizard-2")
        compose.runOnIdle {
            vm.showLoaded(first); vm.change("category", "travel"); vm.next(); vm.change("note", "First trip")
            vm.close(); assertEquals(first.id, vm.state.value.form?.id); assertEquals("First trip", vm.state.value.values["note"])
            vm.showLoaded(second); assertTrue(vm.state.value.values.isEmpty())
            vm.change("category", "food"); vm.next(); vm.change("confirmed", true); vm.next()
            assertTrue(vm.state.value.reviewing)
            vm.close(); vm.showLoaded(first)
            assertEquals("trip", vm.state.value.stepId); assertEquals("First trip", vm.state.value.values["note"])
            assertFalse(vm.state.value.reviewing)
            vm.close(); vm.showLoaded(second)
            assertTrue(vm.state.value.reviewing); assertEquals("food", vm.state.value.values["category"])
            vm.showLoaded(second.copy(status = "cancelled"))
            assertTrue(vm.state.value.values.isEmpty())
            vm.showLoaded(first.copy(expiresAt = 0))
            assertTrue(vm.state.value.values.isEmpty())
        }
    }
    @Test fun wizardReviewScreenshotAndPreviousStepRetainAnswers() {
        val vm = wizardVm()
        compose.runOnIdle {
            vm.showLoaded(wizardForm()); vm.change("category", "travel"); vm.next(); vm.change("note", "Demo business trip")
            vm.next(); vm.change("confirmed", true); vm.next()
        }
        compose.setContent { val s by vm.state.collectAsState(); RelayTheme {
            RequestFormScreen(s, "phone", vm::close, vm::change, {}, {}, {}, {}, vm::next, vm::previous)
        } }
        compose.onNodeWithText("Review your response").performScrollTo().assertIsDisplayed()
        compose.mainClock.advanceTimeBy(500)
        val preview = compose.onRoot().captureToImage().asAndroidBitmap()
        File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "wizard-review.png")
            .outputStream().use { preview.compress(Bitmap.CompressFormat.PNG, 100, it) }
        compose.onNodeWithText("Previous step").performScrollTo().performClick()
        compose.onNodeWithText("Confirmation").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertEquals(true, vm.state.value.values["confirmed"]) }
    }

}
