package com.bluegrain.smsrelay

import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow

class RelayNavigationTest {
    @Test fun savedNavigationRetainsOnlyTargetKindAndEntryOrigin() {
        RequestOrigin.entries.forEach { origin -> RequestKind.entries.forEach { kind ->
            val response = RelayDestination.Response(RequestTarget("a".repeat(64), kind), origin)
            assertEquals(response, restoreDestination(response.metadata()))
            assertEquals(listOf("response", "a".repeat(64), kind.name, origin.name), response.metadata())
        } }
        SettingsSection.entries.forEach { section ->
            val settings = RelayDestination.Settings(section)
            assertEquals(settings, restoreDestination(settings.metadata()))
        }
    }
    @Test fun onlyNotificationResponsesBackgroundOnClose() {
        val target = RequestTarget("a".repeat(64), RequestKind.Form)
        assertTrue(RelayDestination.Response(target, RequestOrigin.Notification).backgroundOnClose())
        assertFalse(RelayDestination.Response(target, RequestOrigin.Inbox).backgroundOnClose())
        assertFalse(RelayDestination.Settings().backgroundOnClose())
        assertFalse(RelayDestination.Inbox.backgroundOnClose())
    }
    @Test fun missingOrUnrecognizedSavedNavigationReturnsHome() {
        assertEquals(RelayDestination.Inbox, restoreDestination(null))
        assertEquals(RelayDestination.Inbox, restoreDestination(listOf("response")))
        assertEquals(RelayDestination.Inbox, restoreDestination(listOf("settings", "retired")))
    }
    @Test fun notificationTargetWaitsForRegistrationAndBothBusyOperations() = runBlocking {
        val session = MutableStateFlow(RelayUiState(configured = true, busy = true))
        val inbox = MutableStateFlow(InboxState(busy = true))
        val opened = mutableListOf<String>()
        val target = RequestTarget("a".repeat(64), RequestKind.Form)
        val load = async { loadResponseWhenReady(target, session, inbox,
            { error("Wrong request kind") }, { opened.add(it); true }) }
        yield(); assertTrue(opened.isEmpty())
        session.value = session.value.copy(signedIn = true)
        yield(); assertTrue(opened.isEmpty())
        session.value = session.value.copy(registered = true)
        yield(); assertTrue(opened.isEmpty())
        session.value = session.value.copy(busy = false)
        yield(); assertTrue(opened.isEmpty())
        inbox.value = inbox.value.copy(busy = false)
        assertTrue(withTimeout(1000) { load.await() })
        assertEquals(listOf(target.id), opened)
    }
    @Test fun changingTheTargetWhileBusyDoesNotOpenTheAbandonedRequest() = runBlocking {
        val session = MutableStateFlow(RelayUiState(configured = true, signedIn = true, registered = true, busy = true))
        val inbox = MutableStateFlow(InboxState())
        val opened = mutableListOf<String>()
        suspend fun open(id: String): Boolean { opened.add(id); return false }
        val first = async { loadResponseWhenReady(RequestTarget("first", RequestKind.Sms), session, inbox, ::open, ::open) }
        yield(); first.cancelAndJoin()
        val second = async { loadResponseWhenReady(RequestTarget("second", RequestKind.Sms), session, inbox, ::open, ::open) }
        session.value = session.value.copy(busy = false)
        assertFalse(withTimeout(1000) { second.await() })
        assertEquals(listOf("second"), opened)
    }
    @Test fun retainedFormDoesNotRequireAnotherFetchButADifferentTargetDoes() = runBlocking {
        val session = MutableStateFlow(RelayUiState(configured = true, signedIn = true, registered = true))
        val form = RequestForm("retained", "Assistant", "Review", "", "submitted", Long.MAX_VALUE,
            emptyList(), emptyList(), null)
        val inbox = MutableStateFlow(InboxState(form = form, busy = true))
        val opened = mutableListOf<String>()
        var entries = 0
        suspend fun unavailable(id: String): Boolean { opened.add(id); return false }
        assertTrue(withTimeout(1000) { loadResponseWhenReady(RequestTarget(form.id, RequestKind.Form),
            session, inbox, ::unavailable, ::unavailable, { entries++ }) })
        assertTrue(opened.isEmpty())
        assertEquals(1, entries)
        inbox.value = inbox.value.copy(busy = false)
        assertFalse(loadResponseWhenReady(RequestTarget("different", RequestKind.Form),
            session, inbox, ::unavailable, ::unavailable))
        assertEquals(listOf("different"), opened)
    }
}
