package com.bluegrain.smsrelay

import android.content.Intent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.viewModelScope
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeFalse
import org.junit.Rule
import org.junit.Test
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

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

    @Test fun inboxTapKeepsTheFeedVisibleUntilTheSelectedFormIsReady() {
        isolatedBuild()
        val id = "b".repeat(64)
        val form = RequestForm(id, "Demo assistant", "Review selected request", "Request details", "pending",
            Long.MAX_VALUE, emptyList(), emptyList(), null)
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            lateinit var inbox: InboxViewModel
            scenario.onActivity { activity ->
                val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                @Suppress("UNCHECKED_CAST")
                val session = RelayViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
                    .get(vm) as kotlinx.coroutines.flow.MutableStateFlow<RelayUiState>
                session.value = session.value.copy(configured = true, signedIn = true, registered = true, busy = true)
                inbox = androidx.lifecycle.ViewModelProvider(activity)[InboxViewModel::class.java]
                @Suppress("UNCHECKED_CAST")
                val forms = InboxViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
                    .get(inbox) as kotlinx.coroutines.flow.MutableStateFlow<InboxState>
                forms.value = forms.value.copy(requests = listOf(form))
            }
            compose.onNodeWithTag("form:$id").performClick()
            compose.onNodeWithText("Inbox").assertIsDisplayed()
            compose.onNodeWithText("Opening…").assertIsDisplayed()
            compose.onNodeWithText("Request response").assertDoesNotExist()
            compose.onNodeWithText("Could not open this request.").assertDoesNotExist()
            assertEquals(RelayDestination.Inbox, destination(scenario))
            scenario.onActivity { inbox.showLoaded(form) }
            compose.onNodeWithText("Request details").assertIsDisplayed()
            compose.onNodeWithText("Request response").assertDoesNotExist()
            compose.onNodeWithText("Opening this request…").assertDoesNotExist()
            compose.onNodeWithText("Could not open this request.").assertDoesNotExist()
            compose.onNodeWithText("Close").performClick()
            compose.onNodeWithTag("form:$id").performClick()
            compose.onNodeWithText("Request details").assertIsDisplayed()
            compose.onNodeWithText("Request response").assertDoesNotExist()
        }
    }

    @Test fun systemBackAbandonsPendingNavigationWithoutCancellingTheRequest() {
        isolatedBuild()
        val id = "c".repeat(64)
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            lateinit var session: kotlinx.coroutines.flow.MutableStateFlow<RelayUiState>
            scenario.onActivity { activity ->
                val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                @Suppress("UNCHECKED_CAST")
                val mutable = RelayViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
                    .get(vm) as kotlinx.coroutines.flow.MutableStateFlow<RelayUiState>
                session = mutable
                session.value = session.value.copy(configured = true, signedIn = true, registered = true, busy = true,
                    request = PhoneRequest(id, "pending_phone", "Assistant", "Sign in", null, Long.MAX_VALUE, null, null))
            }
            compose.onNodeWithTag("sms:$id").performClick()
            compose.onNodeWithText("Opening…").assertIsDisplayed()
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            compose.onNodeWithText("Inbox").assertIsDisplayed()
            compose.onNodeWithText("Opening…").assertDoesNotExist()
            assertEquals("pending_phone", session.value.request?.status)
            assertEquals(RelayDestination.Inbox, destination(scenario))
        }
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
    @Test fun notificationFromInboxReplacesOnlyNavigationAndRepeatedTapsKeepTarget() {
        isolatedBuild()
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            compose.onNodeWithText("Inbox").assertIsDisplayed()
            scenario.onActivity { it.startActivity(notification("sms").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            assertTarget(scenario, "a".repeat(64), RequestKind.Sms)
            compose.onNodeWithText("Request response").assertIsDisplayed()
            scenario.onActivity { it.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            awaitDestination(scenario, RelayDestination.Inbox)
            compose.onNodeWithText("Inbox").assertIsDisplayed()
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
    @Test fun terminalSmsStopsPendingPollBeforeSuccessorListening() {
        isolatedBuild()
        val old = PhoneRequest("c".repeat(64), "ready", "Assistant", "Sign in", null,
            System.currentTimeMillis() + 600_000, System.currentTimeMillis() - 1, null)
        val terminal = old.copy(status = "cancelled")
        val successor = old.copy(id = "d".repeat(64), status = "pending_phone", listeningDeadline = null)
        val delayedResponse = CompletableDeferred<PhoneRequest>()
        var pendingPoll: Job? = null
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            try {
                scenario.onActivity { activity ->
                    val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                    val applyRequest = RelayViewModel::class.java.getDeclaredMethod("applyRequest", PhoneRequest::class.java)
                        .apply { isAccessible = true }
                    val boundId = RelayViewModel::class.java.getDeclaredField("boundId").apply { isAccessible = true }
                    val repo = (activity.application as RelayApplication).repository
                    applyRequest.invoke(vm, old)
                    boundId.set(vm, old.id)
                    // Model an in-flight poll response with a suspended ViewModel job after the old window ended.
                    pendingPoll = vm.viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
                        applyRequest.invoke(vm, delayedResponse.await())
                    }
                    RelayViewModel::class.java.getDeclaredField("poll").apply { isAccessible = true }.set(vm, pendingPoll)
                    MainActivity::class.java.getDeclaredMethod("openFromInbox", String::class.java, RequestKind::class.java)
                        .apply { isAccessible = true }.invoke(activity, old.id, RequestKind.Sms)
                    MainActivity::class.java.getDeclaredMethod("closeDestination").apply { isAccessible = true }.invoke(activity)
                    assertTrue(requireNotNull(pendingPoll).isActive)
                    applyRequest.invoke(vm, terminal)
                    assertEquals(terminal, vm.state.value.request)
                    applyRequest.invoke(vm, successor)
                    boundId.set(vm, successor.id)
                    repo.inFlight = successor.id
                    delayedResponse.complete(terminal)
                }
                runBlocking { withTimeout(5_000) { requireNotNull(pendingPoll).join() } }
                scenario.onActivity { activity ->
                    val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                    assertEquals(successor, vm.state.value.request)
                    assertEquals(successor.id, RelayViewModel::class.java.getDeclaredField("boundId")
                        .apply { isAccessible = true }.get(vm))
                    assertEquals(successor.id, (activity.application as RelayApplication).repository.inFlight)
                }
            } finally {
                pendingPoll?.cancel()
                delayedResponse.cancel()
                (context.applicationContext as RelayApplication).repository.inFlight = null
            }
        }
    }
    @Test fun connectionLinksOpenAdministrationAndKeepItAcrossRecreation() {
        isolatedBuild()
        val link = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("smsrelay://connect?code=ABCDE-FG234"))
            .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.packageName)
        assertEquals(AdministrationActivity::class.java.name, context.packageManager.resolveActivity(link, 0)?.activityInfo?.name)
        ActivityScenario.launch<AdministrationActivity>(link).use { scenario ->
            compose.onNodeWithText("Administration").assertIsDisplayed()
            compose.onNodeWithText("Access").assertIsDisplayed()
            scenario.recreate()
            compose.onNodeWithText("Administration").assertIsDisplayed()
            compose.onNodeWithText("Inbox").assertDoesNotExist()
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            compose.waitUntil(5_000) { scenario.state == Lifecycle.State.DESTROYED }
            assertEquals(Lifecycle.State.DESTROYED, scenario.state)
        }
    }
    @Test fun administrationUsesADifferentTaskAndDoesNotReplaceInboxNavigationOrDrafts() {
        isolatedBuild()
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { inbox ->
            var inboxTask = -1
            lateinit var inboxVm: RelayViewModel
            inbox.onActivity { activity ->
                inboxTask = activity.taskId
                inboxVm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                @Suppress("UNCHECKED_CAST")
                val state = RelayViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
                    .get(inboxVm) as kotlinx.coroutines.flow.MutableStateFlow<RelayUiState>
                state.value = state.value.copy(request = PhoneRequest("retained", "ready", "Assistant", "Sign in", null, Long.MAX_VALUE, null, null))
                inboxVm.changeCode("retained", "123456")
            }
            ActivityScenario.launch<AdministrationActivity>(Intent(context, AdministrationActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use { admin ->
                admin.onActivity { activity ->
                    assertNotEquals(inboxTask, activity.taskId)
                    val adminVm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                    assertNotSame(inboxVm, adminVm)
                    assertNull(adminVm.state.value.request)
                    assertTrue(RelayViewModel::class.java.getDeclaredField("administrationOnly").apply { isAccessible = true }.getBoolean(adminVm))
                }
                compose.onNodeWithText("Administration").assertIsDisplayed()
                assertEquals("123456", inboxVm.state.value.codeDraft)
                assertEquals(RelayDestination.Inbox, destination(inbox))
            }
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
                state.value = state.value.copy(configured = true, signedIn = true, registered = true, busy = true)
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
    @Test fun expiredFormCloseAndBackClearAnswersFromBothEntryOriginsWithoutServiceAccess() {
        isolatedBuild()
        val id = "d".repeat(64)
        val field = FormField("note", "Note", "text", false, 1000, null, null, emptyList(), false)
        for (origin in RequestOrigin.entries) for (back in listOf(false, true)) {
            val intent = if (origin == RequestOrigin.Notification) notification(id = id) else Intent(context, MainActivity::class.java)
            ActivityScenario.launch<MainActivity>(intent).use { scenario ->
                lateinit var expiring: RequestForm
                lateinit var retained: InboxViewModel
                scenario.onActivity { activity ->
                    val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                    @Suppress("UNCHECKED_CAST")
                    val state = RelayViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
                        .get(vm) as kotlinx.coroutines.flow.MutableStateFlow<RelayUiState>
                    state.value = state.value.copy(configured = true, signedIn = true, registered = true)
                    retained = androidx.lifecycle.ViewModelProvider(activity)[InboxViewModel::class.java]
                    expiring = RequestForm(id, "Demo assistant", "Review", "", "pending", System.currentTimeMillis() + 2_000,
                        listOf(field), emptyList(), null, steps = listOf(FormStep("details", "Details", "", listOf("note"))))
                    retained.showLoaded(expiring); retained.change("note", "Expired answer"); retained.next(); retained.close()
                    assertTrue(retained.state.value.reviewing)
                    assertEquals("Expired answer", retained.state.value.values["note"])
                    if (origin == RequestOrigin.Inbox) MainActivity::class.java
                        .getDeclaredMethod("openFromInbox", String::class.java, RequestKind::class.java)
                        .apply { isAccessible = true }.invoke(activity, id, RequestKind.Form)
                }
                compose.waitUntil(5_000) { retained.state.value.now >= expiring.expiresAt }
                compose.onNodeWithText("This request has expired.").assertIsDisplayed()
                if (back) scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                else compose.onNodeWithText("Close").performClick()
                if (origin == RequestOrigin.Notification) compose.waitUntil(5_000) { scenario.state == Lifecycle.State.CREATED }
                else compose.onNodeWithText("Inbox").assertIsDisplayed()
                scenario.onActivity { activity ->
                    assertFalse(activity.isFinishing)
                    assertSame(retained, androidx.lifecycle.ViewModelProvider(activity)[InboxViewModel::class.java])
                    assertTrue(retained.state.value.values.isEmpty())
                    assertNull(retained.state.value.stepId)
                    assertFalse(retained.state.value.reviewing)
                    retained.showLoaded(expiring.copy(expiresAt = Long.MAX_VALUE))
                    assertTrue(retained.state.value.values.isEmpty())
                }
            }
        }
    }
    @Test fun terminalSmsOutcomesStayVisibleAcrossRecreationWithoutServiceAccess() {
        isolatedBuild()
        val id = "e".repeat(64)
        val outcomes = listOf("cancelled" to "Request cancelled", "failed" to "Request could not finish",
            "expired" to "Request expired", "completed" to "Handled on another phone")
        for (origin in RequestOrigin.entries) {
            val intent = if (origin == RequestOrigin.Notification) notification("sms", id) else Intent(context, MainActivity::class.java)
            ActivityScenario.launch<MainActivity>(intent).use { scenario ->
                lateinit var retained: RelayViewModel
                for ((status, message) in outcomes) {
                    scenario.onActivity { activity ->
                        val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                        retained = vm
                        @Suppress("UNCHECKED_CAST")
                        val state = RelayViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
                            .get(vm) as kotlinx.coroutines.flow.MutableStateFlow<RelayUiState>
                        state.value = state.value.copy(configured = true, signedIn = true, registered = true,
                            busy = true,
                            request = PhoneRequest(id, status, "Demo assistant", "Sign in", null, Long.MAX_VALUE, null,
                                if (status == "completed") "handled_on_another_device" else null))
                        if (origin == RequestOrigin.Inbox) MainActivity::class.java
                            .getDeclaredMethod("openFromInbox", String::class.java, RequestKind::class.java)
                            .apply { isAccessible = true }.invoke(activity, id, RequestKind.Sms)
                    }
                    compose.onNodeWithText(message).assertIsDisplayed()
                    scenario.recreate()
                    compose.onNodeWithText(message).assertIsDisplayed()
                    compose.onNodeWithText("Retry").assertDoesNotExist()
                    scenario.onActivity { activity ->
                        assertSame(retained, androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java])
                        assertEquals(status, retained.state.value.request?.status)
                    }
                    assertEquals(RelayDestination.Response(RequestTarget(id, RequestKind.Sms), origin), destination(scenario))
                }
            }
        }
    }
    @Test fun formsClosedWhileLiveLoseCurrentAndCachedAnswersOnLocalExpiry() {
        isolatedBuild()
        val id = "f".repeat(64)
        val field = FormField("note", "Note", "text", false, 1000, null, null, emptyList(), false)
        for (origin in RequestOrigin.entries) for (switchForm in listOf(false, true)) {
            val intent = if (origin == RequestOrigin.Notification) notification(id = id) else Intent(context, MainActivity::class.java)
            ActivityScenario.launch<MainActivity>(intent).use { scenario ->
                lateinit var expiring: RequestForm
                lateinit var retained: InboxViewModel
                scenario.onActivity { activity ->
                    val vm = androidx.lifecycle.ViewModelProvider(activity)[RelayViewModel::class.java]
                    @Suppress("UNCHECKED_CAST")
                    val state = RelayViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
                        .get(vm) as kotlinx.coroutines.flow.MutableStateFlow<RelayUiState>
                    state.value = state.value.copy(configured = true, signedIn = true, registered = true)
                    retained = androidx.lifecycle.ViewModelProvider(activity)[InboxViewModel::class.java]
                    expiring = RequestForm(id, "Demo assistant", "Review", "", "pending", System.currentTimeMillis() + 3_000,
                        listOf(field), emptyList(), null, steps = listOf(FormStep("details", "Details", "", listOf("note"))))
                    retained.showLoaded(expiring); retained.change("note", "Live answer"); retained.next()
                    if (origin == RequestOrigin.Inbox) MainActivity::class.java
                        .getDeclaredMethod("openFromInbox", String::class.java, RequestKind::class.java)
                        .apply { isAccessible = true }.invoke(activity, id, RequestKind.Form)
                }
                compose.onNodeWithText("Close").performClick()
                scenario.onActivity {
                    assertTrue(retained.state.value.now < expiring.expiresAt)
                    assertEquals("Live answer", retained.state.value.values["note"])
                    if (switchForm) {
                        retained.showLoaded(expiring.copy(id = "other", expiresAt = Long.MAX_VALUE))
                        retained.change("note", "Other live answer")
                    }
                }
                compose.waitUntil(6_000) { retained.state.value.now >= expiring.expiresAt }
                scenario.onActivity {
                    if (switchForm) assertEquals("Other live answer", retained.state.value.values["note"])
                    else {
                        assertTrue(retained.state.value.values.isEmpty())
                        assertNull(retained.state.value.stepId)
                        assertFalse(retained.state.value.reviewing)
                    }
                    retained.showLoaded(expiring.copy(expiresAt = Long.MAX_VALUE))
                    assertTrue(retained.state.value.values.isEmpty())
                }
            }
        }
    }
}
