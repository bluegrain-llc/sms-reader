package com.bluegrain.smsrelay

import org.junit.Assert.*
import org.junit.Test

class CodeExtractorTest {
    @Test fun numericAndAlphanumeric() {
        assertEquals(listOf("123456"), CodeExtractor.candidates("Your code is 123456."))
        assertEquals(listOf("A1b2C3"), CodeExtractor.candidates("Use A1b2C3 to sign in."))
        assertEquals(listOf("0000", "AB12345678"), CodeExtractor.candidates("0000 / AB12345678"))
    }
    @Test fun multipleCandidatesArePreservedAndDeduplicated() {
        assertEquals(listOf("123456", "987654"), CodeExtractor.candidates("Code 123456. Reference 987654. Code 123456."))
    }
    @Test fun unsupportedFormatsAreNeverTruncated() {
        assertTrue(CodeExtractor.candidates("123 12345678901 abcdef １２３４５６").isEmpty())
    }
    @Test fun enteredCodesRequireSupportedFormatWithoutTruncation() {
        assertTrue(CodeExtractor.validCode("0000"))
        assertTrue(CodeExtractor.validCode("A12b34"))
        for (value in listOf("ABC", "abcdef", "12345678901", "１２３４５６", "12 3456", "12-3456")) assertFalse(CodeExtractor.validCode(value))
    }
    @Test fun gateRequiresConsentForThisRequest() {
        val gate = ConsentGate()
        gate.bind("request-one")
        assertFalse(gate.permits("request-one", "123456"))
        assertTrue(gate.approve("wrong-request", "Code 123456").isEmpty())
        gate.approve("request-one", "Code 123456. Reference 654321.")
        assertTrue(gate.permits("request-one", "123456"))
        assertFalse(gate.permits("request-one", "999999"))
        assertFalse(gate.permits("wrong-request", "123456"))
        gate.clear()
        assertFalse(gate.permits("request-one", "123456"))
    }
}
