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

class ApprovalScreenTest {
    @get:Rule val compose = createComposeRule()
    @Test fun focusedRequestRendersMarkdownAndCandidateSelectionSubmitsOnce() {
        var selected: String? = null
        var ui by androidx.compose.runtime.mutableStateOf(RelayUiState(configured = true, signedIn = true, registered = true,
            request = PhoneRequest("request", "awaiting_consent", "My assistant", "## Bizee verification\n\nEnter the **verification code** to finish signing in.", null, 600_000, 300_000, null, "Sign in"),
            candidates = listOf("123456", "654321"), now = 0))
        compose.setContent {
            RelayTheme { RelayScreen(ui,
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
        val preview = compose.onRoot().captureToImage().asAndroidBitmap()
        File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "sms-request-preview.png")
            .outputStream().use { preview.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun cancelRemainsAvailableDuringUpload() {
        var cancelled = false
        compose.setContent {
            RelayTheme {
                RelayScreen(RelayUiState(configured = true, signedIn = true, registered = true, busy = true,
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
        compose.setContent { RelayTheme { RelayScreen(ui,
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
        compose.setContent { RelayTheme { RelayScreen(ui, onSubmitCode = { sent = true }) } }
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
        compose.setContent { RelayTheme { RelayScreen(ui, onRequestSent = { closed++ }) } }
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
                RelayScreen(RelayUiState(configured = true, signedIn = true, registered = true,
                    email = "owner@example.test", devices = listOf(
                        DeviceRow("first", "Samsung phone", false, true),
                        DeviceRow("second", "Pixel phone", true, false))),
                    )
            }
        }
        compose.onNodeWithText("Ready for requests").assertIsDisplayed()
        compose.onNodeWithText("Connect an app or bot").assertDoesNotExist()
        compose.onNodeWithText("Admin").performClick()
        compose.onNodeWithText("Connect an app or bot").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Copy connection").assertDoesNotExist()
        val preview = compose.onRoot().captureToImage().asAndroidBitmap()
        File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "admin-preview.png")
            .outputStream().use { preview.compress(Bitmap.CompressFormat.PNG, 100, it) }
        compose.onNodeWithText("Devices").performScrollTo().performClick()
        compose.onNodeWithText("Samsung phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("This phone · Receives requests").assertIsDisplayed()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("Pixel phone"))
        compose.onNodeWithText("Pixel phone").assertIsDisplayed()
    }
    @Test fun anotherPhonesApprovalIsClearlyReportedWithoutTheCode() {
        compose.setContent {
            RelayTheme {
                RelayScreen(RelayUiState(configured = true, signedIn = true, registered = true,
                    request = PhoneRequest("request", "completed", "My assistant", "Sign in", null,
                        600_000, 300_000, "handled_on_another_device")),
                    )
            }
        }
        compose.onNodeWithText("Handled on another phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("SMS code").assertDoesNotExist()
        compose.onNodeWithText("Admin").assertDoesNotExist()
        compose.onNodeWithText("Close").assertIsDisplayed()
    }
    @Test fun openingConnectionRequiresAnExplicitOwnerDecision() {
        var decision: Boolean? = null
        compose.setContent {
            RelayTheme {
                RelayScreen(RelayUiState(configured = true, signedIn = true, registered = true,
                    email = "owner@example.test", now = 0,
                    connection = ConnectionReview("ABCDE-FG234", "Invoice bot", "Receive sign-in codes", "pending", 600_000, 30)),
                    onConnectionDecision = { code, approved -> assertEquals("ABCDE-FG234", code); decision = approved })
            }
        }
        compose.onNodeWithText("Invoice bot").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("ABCDE-FG234").assertIsDisplayed()
        assertEquals(null, decision)
        val preview = compose.onRoot().captureToImage().asAndroidBitmap()
        File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "connection-preview.png")
            .outputStream().use { preview.compress(Bitmap.CompressFormat.PNG, 100, it) }
        compose.onNodeWithText("Approve connection").performScrollTo().performClick()
        assertEquals(true, decision)
    }
    @Test fun expiredConnectionCannotBeApproved() {
        compose.setContent {
            RelayTheme {
                RelayScreen(RelayUiState(configured = true, signedIn = true, registered = true, now = 600_000,
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
                RelayScreen(RelayUiState(configured = true, signedIn = true, registered = true,
                    connectionCode = "ABCDE-FG234", error = "Check your network and retry."),
                    onReviewConnection = { retried = it })
            }
        }
        compose.onNodeWithText("ABCDE-FG234").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Approve connection").assertDoesNotExist()
        compose.onNodeWithText("Review connection").performScrollTo().performClick()
        assertEquals("ABCDE-FG234", retried)
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
        compose.onNodeWithText("Back to inbox").performScrollTo().performClick()
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
        compose.setContent { RelayTheme { RelayScreen(RelayUiState(configured = true, signedIn = true, registered = true,
            showSmsRequest = false, request = PhoneRequest("sms", "ready", "SMS bot", "SMS", null, 600_000, 300_000, null), now = 0,
            grants = listOf(GrantRow("grant", "Expense assistant", false, 600_000))),
            inbox = listOf(form()), onOpenForm = { opened = it }, onApproveForms = { _, value -> approved = value }) } }
        compose.onNodeWithText("Return to SMS request").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Open request").performScrollTo().performClick()
        assertEquals("form-1", opened)
        compose.onNodeWithText("Admin").performScrollTo().performClick()
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

}
