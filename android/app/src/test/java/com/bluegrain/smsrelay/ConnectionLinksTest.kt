package com.bluegrain.smsrelay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionLinksTest {
    private val base = "https://relay.example.test"
    @Test fun verifiedServiceAndFallbackLinksNormalizeOnlyComparisonCodes() {
        assertEquals("ABCDEFG234", ConnectionLinks.code("$base/connect?code=ABCDE-FG234", base))
        assertEquals("ABCDEFG234", ConnectionLinks.code("smsrelay://connect?code=abcde-fg234", base))
    }
    @Test fun unrelatedHostsAndPathsCannotOpenAConnection() {
        assertNull(ConnectionLinks.code("https://other.example.test/connect?code=ABCDE-FG234", base))
        assertNull(ConnectionLinks.code("$base/other?code=ABCDE-FG234", base))
        assertNull(ConnectionLinks.code("http://relay.example.test/connect?code=ABCDE-FG234", base))
        assertNull(ConnectionLinks.code("https://attacker@relay.example.test/connect?code=ABCDE-FG234", base))
    }
    @Test fun malformedDuplicateAndCredentialValuesAreRejected() {
        assertNull(ConnectionLinks.code("$base/connect?code=ABCDE-FG234&code=ZZZZZ-ZZZZZ", base))
        assertNull(ConnectionLinks.code("$base/connect?code=%XX", base))
        assertNull(ConnectionLinks.code("$base/connect?code=smsr_not_a_comparison_code", base))
    }
}
