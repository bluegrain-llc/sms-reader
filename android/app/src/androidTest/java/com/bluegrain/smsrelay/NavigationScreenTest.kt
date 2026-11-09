package com.bluegrain.smsrelay

import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class NavigationScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val now = java.time.Instant.parse("2026-11-09T12:00:00Z").toEpochMilli()
    private val request = PhoneRequest("sms", "ready", "SMS assistant", "Verify login", null, now + 600_000, now + 300_000, null, "Sign in")
    private fun form(id: String = "first") = RequestForm(id, "Expense assistant", "Review $id invoice", "Review the invoice.", "pending", now + 600_000, emptyList(),
        listOf(FormAction("approve", "Approve", "approve"), FormAction("decline", "Decline", "decline")), null)
    private val session = RelayUiState(configured = true, signedIn = true, registered = true, now = now)

    @Test fun rowsFillSafeWidthAndOnlyPendingRequestsAppearInOrder() {
        var opened: String? = null
        compose.setContent { RelayTheme { InboxScreen(session.copy(request = request),
            listOf(form(), form("second"), form("done").copy(status = "submitted"), form("expired").copy(expiresAt = 0)), {}, {}, {}, { opened = it }) } }
        val list = compose.onNodeWithTag("inbox-list").getUnclippedBoundsInRoot()
        val sms = compose.onNodeWithTag("sms:sms").getUnclippedBoundsInRoot()
        val first = compose.onNodeWithTag("form:first").getUnclippedBoundsInRoot()
        val second = compose.onNodeWithTag("form:second").getUnclippedBoundsInRoot()
        assertEquals(list.left, first.left); assertEquals(list.right, first.right)
        assertEquals(list.left, sms.left); assertEquals(list.right, sms.right)
        assertTrue(sms.bottom <= first.top); assertTrue(first.bottom <= second.top)
        compose.onNodeWithText("Review done invoice").assertDoesNotExist()
        compose.onNodeWithText("Review expired invoice").assertDoesNotExist()
        preview("inbox-preview.png")
        compose.onNodeWithTag("form:first").performClick()
        assertEquals("first", opened)
    }

    @Test fun notificationEntryShowsOnlyAuthenticationLoadingOrRetryForItsTarget() {
        var state by mutableStateOf(session.copy(signedIn = false, registered = false))
        var loading by mutableStateOf(false)
        var retried = 0
        val route = RelayDestination.Response(RequestTarget("new", RequestKind.Sms), RequestOrigin.Notification)
        compose.setContent { RelayTheme { RelayScreen(state.copy(request = request), route, responseLoading = loading, onRetry = { retried++ }) } }
        compose.onNodeWithText("Continue with Google").assertIsDisplayed()
        compose.onNodeWithText("Inbox").assertDoesNotExist(); compose.onNodeWithText("Settings").assertDoesNotExist()
        compose.runOnIdle { state = session.copy(registered = false, busy = true) }
        compose.onNodeWithText("Finish connecting").assertIsNotEnabled()
        compose.runOnIdle { state = session; loading = true }
        compose.onNodeWithText("Opening this request…").assertIsDisplayed()
        compose.onNodeWithText("SMS assistant — Sign in").assertDoesNotExist()
        compose.runOnIdle { loading = false; state = state.copy(error = "Offline") }
        compose.onNodeWithText("Offline").assertIsDisplayed()
        compose.onNodeWithText("Retry").performClick(); assertEquals(1, retried)
        compose.onNodeWithText("Inbox").assertDoesNotExist(); compose.onNodeWithText("Settings").assertDoesNotExist()
    }

    @Test fun settingsIsNotInterruptedByAnArrivingSmsAndBackReturnsToInbox() {
        var state by mutableStateOf(session)
        var route by mutableStateOf<RelayDestination>(RelayDestination.Settings(SettingsSection.History))
        compose.setContent { RelayTheme { RelayScreen(state, route, onBack = { route = RelayDestination.Inbox }) } }
        compose.runOnIdle { state = session.copy(request = request) }
        compose.onNodeWithText("Recent outcomes").assertIsDisplayed()
        compose.onNodeWithText("SMS code").assertDoesNotExist()
        preview("settings-history-preview.png")
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("Inbox").assertIsDisplayed()
        compose.onNodeWithText("SMS assistant").assertIsDisplayed()
    }

    @Test fun smsCloseAndSystemBackPreserveTheDraftDuringUploadAndCancelIsExplicit() {
        var closes = 0
        var cancels = 0
        val state = session.copy(request = request, busy = true, codeDraft = "123456")
        compose.setContent { RelayTheme { RelayScreen(state,
            RelayDestination.Response(RequestTarget("sms", RequestKind.Sms), RequestOrigin.Notification), responseReady = true,
            onBack = { closes++ }, onCancel = { cancels++ }) } }
        compose.onNodeWithText("Close").performClick()
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        assertEquals(2, closes); assertEquals(0, cancels); assertEquals("123456", state.codeDraft)
        compose.onNodeWithText("Cancel request").performScrollTo().performClick(); assertEquals(1, cancels)
    }

    @Test fun wizardSystemBackClosesAndExplicitPreviousKeepsStepNavigation() {
        var closes = 0
        var previous = 0
        val wizard = form().copy(steps = listOf(FormStep("first", "First step", "", emptyList()), FormStep("second", "Second step", "", emptyList())))
        compose.setContent { RelayTheme { RequestFormScreen(InboxState(form = wizard, stepId = "second", now = now), "phone",
            { closes++ }, { _, _ -> }, {}, {}, {}, {}, onPrevious = { previous++ }) } }
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        assertEquals(1, closes); assertEquals(0, previous)
        compose.onNodeWithText("Previous step").performScrollTo().performClick(); assertEquals(1, previous)
    }

    @Test fun formConfirmationStaysVisibleUntilClosed() {
        var closes = 0
        var ui by mutableStateOf(InboxState(form = form(), now = now))
        compose.setContent { RelayTheme { RelayScreen(session, RelayDestination.Response(RequestTarget("first", RequestKind.Form), RequestOrigin.Notification),
            formState = ui, responseReady = true, onBack = { closes++ }, onFormSubmit = { ui = ui.copy(form = form().copy(status = "submitted")) }) } }
        compose.onNodeWithText("Approve").performScrollTo().performClick()
        compose.onNodeWithText("Your response was accepted.").performScrollTo().assertIsDisplayed()
        assertEquals(0, closes)
        compose.onNodeWithText("Close").performScrollTo().performClick(); assertEquals(1, closes)
    }

    private fun preview(name: String) {
        compose.mainClock.advanceTimeBy(500)
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        java.io.File(context.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }
}
