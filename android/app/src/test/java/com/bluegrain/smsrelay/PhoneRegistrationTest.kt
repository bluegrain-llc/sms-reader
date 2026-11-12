package com.bluegrain.smsrelay

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class PhoneRegistrationTest {
    @Test fun onboardingRefreshesThePhoneBeforeResumingIt() = runBlocking {
        val events = mutableListOf<String>()
        val paused = registerReceivingPhone(true,
            register = { events.add("registered"); true },
            resume = { events.add("resumed") })
        assertFalse(paused)
        assertEquals(listOf("registered", "resumed"), events)
    }
    @Test fun ordinaryRegistrationPreservesPauseAndActivePhonesNeedNoResume() = runBlocking {
        for ((resumePaused, paused) in listOf(false to true, false to false, true to false)) {
            assertEquals(paused, registerReceivingPhone(resumePaused,
                register = { paused }, resume = { fail("Resume is unnecessary") }))
        }
    }
    @Test fun registrationOrResumeFailureCannotReportAnActivePhone() = runBlocking {
        for (failRegistration in listOf(true, false)) {
            var resumed = false
            try {
                registerReceivingPhone(true,
                    register = { if (failRegistration) error("registration failed"); true },
                    resume = { resumed = true; error("resume failed") })
                fail("Setup must fail")
            } catch (_: IllegalStateException) { assertEquals(!failRegistration, resumed) }
        }
    }
}
