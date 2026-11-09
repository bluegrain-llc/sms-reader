package com.bluegrain.smsrelay

import android.content.Intent
import androidx.lifecycle.Lifecycle
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeFalse
import org.junit.Rule
import org.junit.Test

// Exercises actual activity entry/recreation without an account, FCM, or service traffic.
class NotificationNavigationTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun notification(kind: String = "form", id: String = "a".repeat(64)) = Intent(context, MainActivity::class.java)
        .putExtra("requestId", id).putExtra("kind", kind).putExtra("notificationTap", true)
    private fun isolatedBuild() = assumeFalse((context.applicationContext as RelayApplication).configured)
    private fun destination(scenario: ActivityScenario<MainActivity>): RelayDestination? {
        var destination: RelayDestination? = null
        scenario.onActivity { activity ->
            destination = MainActivity::class.java.getDeclaredMethod("getDestination")
                .apply { isAccessible = true }.invoke(activity) as RelayDestination
        }
        return destination
    }
    private fun awaitDestination(scenario: ActivityScenario<MainActivity>, expected: RelayDestination) {
        compose.waitUntil(5_000) { destination(scenario) == expected }
        assertEquals(expected, destination(scenario))
    }
    private fun assertTarget(scenario: ActivityScenario<MainActivity>, id: String, kind: RequestKind) {
        awaitDestination(scenario, RelayDestination.Response(RequestTarget(id, kind), RequestOrigin.Notification))
    }

    @Test fun coldNotificationSurvivesRecreationAndCloseBackgroundsWithoutFinishing() {
        isolatedBuild()
        ActivityScenario.launch<MainActivity>(notification()).use { scenario ->
            compose.onNodeWithText("Request response").assertIsDisplayed()
            compose.onNodeWithText("Inbox").assertDoesNotExist(); compose.onNodeWithText("Settings").assertDoesNotExist()
            scenario.recreate()
            compose.onNodeWithText("Request response").assertIsDisplayed()
            assertTarget(scenario, "a".repeat(64), RequestKind.Form)
            scenario.onActivity { activity ->
                activity.onBackPressedDispatcher.onBackPressed()
                assertFalse(activity.isFinishing)
            }
            compose.waitUntil(5_000) { scenario.state == Lifecycle.State.CREATED }
            assertEquals(Lifecycle.State.CREATED, scenario.state)
        }
    }
    @Test fun notificationFromInboxAndSettingsReplacesOnlyNavigationAndRepeatedTapsKeepTarget() {
        isolatedBuild()
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            compose.onNodeWithText("Inbox").assertIsDisplayed()
            scenario.onActivity { it.startActivity(notification("sms").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            assertTarget(scenario, "a".repeat(64), RequestKind.Sms)
            compose.onNodeWithText("Request response").assertIsDisplayed()
            scenario.onActivity { it.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            awaitDestination(scenario, RelayDestination.Inbox)
            compose.onNodeWithText("Settings").performClick()
            compose.onNodeWithText("Access").assertIsDisplayed()
            scenario.onActivity { it.startActivity(notification(id = "b".repeat(64)).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            assertTarget(scenario, "b".repeat(64), RequestKind.Form)
            compose.onNodeWithText("Request response").assertIsDisplayed()
            scenario.onActivity { activity ->
                repeat(3) { activity.startActivity(notification(id = "b".repeat(64)).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            }
            scenario.recreate()
            compose.onNodeWithText("Request response").assertIsDisplayed()
            assertTarget(scenario, "b".repeat(64), RequestKind.Form)
            compose.onNodeWithText("Inbox").assertDoesNotExist(); compose.onNodeWithText("Access").assertDoesNotExist()
        }
    }
    @Test fun smsDraftSurvivesActualInboxCloseAndSystemBackWhileBusy() {
        isolatedBuild()
        val id = "c".repeat(64)
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            var retained: RelayViewModel? = null
            fun openBusyResponse() {
                scenario.onActivity { activity ->
                    val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                    retained?.let { assertSame(it, vm) }
                    retained = vm
                    @Suppress("UNCHECKED_CAST")
                    val state = RelayViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
                        .get(vm) as kotlinx.coroutines.flow.MutableStateFlow<RelayUiState>
                    state.value = state.value.copy(request = PhoneRequest(id, "ready", "Assistant", "Sign in", null,
                        System.currentTimeMillis() + 600_000, null, null), busy = false)
                    if (state.value.codeDraft.isEmpty()) vm.changeCode(id, "123456")
                    state.value = state.value.copy(busy = true)
                    MainActivity::class.java.getDeclaredMethod("openFromInbox", String::class.java, RequestKind::class.java)
                        .apply { isAccessible = true }.invoke(activity, id, RequestKind.Sms)
                }
                compose.onNodeWithText("Request response").assertIsDisplayed()
            }
            fun assertDraftRetained() {
                compose.onNodeWithText("Inbox").assertIsDisplayed()
                scenario.onActivity { activity ->
                    val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                    assertSame(retained, vm)
                    assertEquals("123456", vm.state.value.codeDraft)
                    assertEquals(id, vm.state.value.request?.id)
                    assertEquals("ready", vm.state.value.request?.status)
                    assertTrue(vm.state.value.busy)
                }
            }
            openBusyResponse()
            compose.onNodeWithText("Close").performClick()
            assertDraftRetained()
            openBusyResponse()
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            assertDraftRetained()
        }
    }
    @Test fun connectionLinksOpenAccessAndKeepItAcrossRecreation() {
        isolatedBuild()
        val link = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW)
            .setData(android.net.Uri.parse("smsrelay://connect?code=ABCDE-FG234"))
        ActivityScenario.launch<MainActivity>(link).use { scenario ->
            compose.onNodeWithText("Settings").assertIsDisplayed()
            compose.onNodeWithText("Access").assertIsDisplayed()
            scenario.recreate()
            compose.onNodeWithText("Settings").assertIsDisplayed()
            compose.onNodeWithText("Back").performClick()
            compose.onNodeWithText("Inbox").assertIsDisplayed()
        }
    }
    @Test fun wizardDraftAndCurrentStepSurviveActivityRotationInTheSameSession() {
        isolatedBuild()
        val field = FormField("note", "Note", "text", true, 1000, null, null, emptyList(), false)
        val form = RequestForm("draft", "Demo assistant", "Review", "", "pending", System.currentTimeMillis() + 600_000,
            listOf(field), emptyList(), null, steps = listOf(FormStep("first", "Details", "", listOf("note")), FormStep("second", "Review", "", emptyList())))
        var original: InboxViewModel? = null
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            scenario.onActivity { activity ->
                val vm = androidx.lifecycle.ViewModelProvider(activity)[InboxViewModel::class.java]
                original = vm
                vm.showLoaded(form); vm.change("note", "In-memory draft"); vm.next()
            }
            scenario.recreate()
            scenario.onActivity { activity ->
                val vm = androidx.lifecycle.ViewModelProvider(activity)[InboxViewModel::class.java]
                assertSame(original, vm)
                assertEquals("In-memory draft", vm.state.value.values["note"])
                assertEquals("second", vm.state.value.stepId)
                assertEquals("pending", vm.state.value.form?.status)
            }
        }
    }
    @Test fun retainedFormDraftAndConfirmationStayVisibleAcrossRecreationWithoutServiceAccess() {
        isolatedBuild()
        val field = FormField("note", "Note", "text", false, 1000, null, null, emptyList(), false)
        val form = RequestForm("retained", "Demo assistant", "Review", "", "pending", System.currentTimeMillis() + 600_000,
            listOf(field), emptyList(), null)
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            var original: InboxViewModel? = null
            scenario.onActivity { activity ->
                val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                @Suppress("UNCHECKED_CAST")
                val state = RelayViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
                    .get(vm) as kotlinx.coroutines.flow.MutableStateFlow<RelayUiState>
                state.value = state.value.copy(configured = true, signedIn = true, registered = true)
                val inbox = androidx.lifecycle.ViewModelProvider(activity)[InboxViewModel::class.java]
                original = inbox
                inbox.showLoaded(form); inbox.change("note", "In-memory draft")
                MainActivity::class.java.getDeclaredMethod("openFromInbox", String::class.java, RequestKind::class.java)
                    .apply { isAccessible = true }.invoke(activity, form.id, RequestKind.Form)
            }
            compose.onNodeWithText("In-memory draft").assertIsDisplayed()
            scenario.recreate()
            compose.onNodeWithText("In-memory draft").assertIsDisplayed()
            compose.onNodeWithText("Retry").assertDoesNotExist()
            scenario.onActivity { activity ->
                val inbox = androidx.lifecycle.ViewModelProvider(activity)[InboxViewModel::class.java]
                assertSame(original, inbox)
                assertNull(inbox.state.value.error)
                inbox.showLoaded(form.copy(status = "submitted"))
            }
            compose.onNodeWithText("Your response was accepted.").assertIsDisplayed()
            scenario.recreate()
            compose.onNodeWithText("Your response was accepted.").assertIsDisplayed()
            compose.onNodeWithText("Retry").assertDoesNotExist()
            scenario.onActivity { activity ->
                val inbox = androidx.lifecycle.ViewModelProvider(activity)[InboxViewModel::class.java]
                assertSame(original, inbox)
                assertEquals("submitted", inbox.state.value.form?.status)
                assertNull(inbox.state.value.error)
            }
            compose.onNodeWithText("Close").performClick()
            compose.onNodeWithText("Inbox").assertIsDisplayed()
        }
    }
}
