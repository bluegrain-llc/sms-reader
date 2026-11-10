package com.bluegrain.smsrelay

import android.content.Intent
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.common.api.CommonStatusCodes
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

/** Drives production status handlers with synthetic metadata; no SDK, SMS or service traffic. */
class ListenerStatusTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as RelayApplication
    private fun field(target: Any, name: String, value: Any?) {
        target.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(target, value)
    }
    private fun field(target: Any, name: String): Any? =
        target.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(target)
    @Suppress("UNCHECKED_CAST")
    private fun <T> state(target: Any) = field(target, "mutable") as MutableStateFlow<T>
    private fun signal(target: Any, id: String, window: SmsListenerWindow, status: Int): Job =
        target.javaClass.getDeclaredMethod("onListenerStatus", String::class.java, SmsListenerWindow::class.java,
            Int::class.javaPrimitiveType, Intent::class.java).apply { isAccessible = true }
            .invoke(target, id, window, status, null) as Job
    private fun join(job: Job) = runBlocking { withTimeout(5_000) { job.join() } }
    private fun fixture(block: (ViewModelStore) -> Unit) {
        check(!app.configured) { "Listener handler tests require an unconfigured build" }
        val stores = ViewModelStore()
        try { block(stores) } finally { instrumentation.runOnMainSync { stores.clear() } }
    }
    private fun retain(stores: ViewModelStore, vm: ViewModel) { stores.put(vm.javaClass.name, vm) }

    @Test fun smsEarlyTimeoutWaitsForReadinessWithoutFailingOrClearingManualEntry() = fixture { stores ->
        lateinit var vm: RelayViewModel
        lateinit var job: Job
        val window = SmsListenerWindow(0) { 378 }
        instrumentation.runOnMainSync {
            vm = RelayViewModel(app); retain(stores, vm)
            state<RelayUiState>(vm).value = RelayUiState(request = PhoneRequest("request", "ready", "Assistant", "Verify", null,
                Long.MAX_VALUE, Long.MAX_VALUE, null), codeDraft = "123456")
            field(vm, "boundId", "request"); field(vm, "listenerWindow", window)
            job = signal(vm, "request", window, CommonStatusCodes.TIMEOUT)
            assertTrue(job.isActive)
            window.ready.complete(true)
        }
        join(job)
        instrumentation.runOnMainSync {
            assertEquals("ready", vm.state.value.request?.status)
            assertEquals("123456", vm.state.value.codeDraft)
            assertSame(window, field(vm, "listenerWindow"))
            assertEquals(false, field(vm, "blocked"))
            field(vm, "consentRequestId", "request")
            vm.consentResult("request", false, null)
        }
        instrumentation.waitForIdleSync()
        assertTrue(vm.state.value.autofillDeclined)
        assertEquals("ready", vm.state.value.request?.status)
    }

    @Test fun smsSupersededTimeoutAndSuccessCannotTouchReplacementAfterReadiness() = fixture { stores ->
        lateinit var vm: RelayViewModel
        val old = SmsListenerWindow(0) { 300_000 }
        val replacement = SmsListenerWindow(300_000) { 300_001 }
        lateinit var timeout: Job
        lateinit var success: Job
        instrumentation.runOnMainSync {
            vm = RelayViewModel(app); retain(stores, vm)
            state<RelayUiState>(vm).value = RelayUiState(request = PhoneRequest("new", "ready", "Assistant", "Verify", null,
                Long.MAX_VALUE, Long.MAX_VALUE, null), codeDraft = "654321")
            field(vm, "boundId", "old"); field(vm, "listenerWindow", old)
            timeout = signal(vm, "old", old, CommonStatusCodes.TIMEOUT)
            success = signal(vm, "old", old, CommonStatusCodes.SUCCESS)
            field(vm, "boundId", "new"); field(vm, "listenerWindow", replacement)
            old.ready.complete(true)
        }
        join(timeout); join(success)
        assertEquals("new", vm.state.value.request?.id)
        assertEquals("654321", vm.state.value.codeDraft)
        assertSame(replacement, field(vm, "listenerWindow"))
        assertNull(vm.state.value.error)
    }

    @Test fun formHelperIgnoresEarlyTimeoutThenCleansUpAtOriginalMonotonicExpiry() = fixture { stores ->
        lateinit var vm: InboxViewModel
        var elapsed = 378L
        val window = SmsListenerWindow(0) { elapsed }
        lateinit var early: Job
        instrumentation.runOnMainSync {
            vm = InboxViewModel(app); retain(stores, vm)
            val form = RequestForm("form", "Assistant", "Verify", "", "pending", Long.MAX_VALUE,
                emptyList(), emptyList(), null)
            state<InboxState>(vm).value = InboxState(form = form, values = mapOf("code" to "manual"), helperUntil = Long.MAX_VALUE)
            field(vm, "helperRequest", form.id); field(vm, "listenerWindow", window)
            early = signal(vm, form.id, window, CommonStatusCodes.TIMEOUT)
            assertTrue(early.isActive)
            window.ready.complete(true)
        }
        join(early)
        assertSame(window, field(vm, "listenerWindow"))
        assertEquals(Long.MAX_VALUE, vm.state.value.helperUntil)
        lateinit var expired: Job
        instrumentation.runOnMainSync { elapsed = 300_000; expired = signal(vm, "form", window, CommonStatusCodes.TIMEOUT) }
        join(expired)
        assertNull(field(vm, "listenerWindow"))
        assertEquals(0L, vm.state.value.helperUntil)
        assertEquals("pending", vm.state.value.form?.status)
        assertEquals(mapOf("code" to "manual"), vm.state.value.values)
    }

    @Test fun formHelperCancelledOrReboundWhileWaitingIgnoresBothSignalKinds() = fixture { stores ->
        lateinit var vm: InboxViewModel
        val old = SmsListenerWindow(0) { 300_000 }
        val replacement = SmsListenerWindow(300_000) { 300_001 }
        lateinit var timeout: Job
        lateinit var success: Job
        instrumentation.runOnMainSync {
            vm = InboxViewModel(app); retain(stores, vm)
            val form = RequestForm("new", "Assistant", "Verify", "", "pending", Long.MAX_VALUE,
                emptyList(), emptyList(), null)
            state<InboxState>(vm).value = InboxState(form = form, helperUntil = Long.MAX_VALUE)
            field(vm, "helperRequest", "old"); field(vm, "listenerWindow", old)
            timeout = signal(vm, "old", old, CommonStatusCodes.TIMEOUT)
            success = signal(vm, "old", old, CommonStatusCodes.SUCCESS)
            old.close()
            field(vm, "helperRequest", "new"); field(vm, "listenerWindow", replacement)
        }
        join(timeout); join(success)
        assertSame(replacement, field(vm, "listenerWindow"))
        assertEquals(Long.MAX_VALUE, vm.state.value.helperUntil)
        assertNull(vm.state.value.consent)
    }
}
