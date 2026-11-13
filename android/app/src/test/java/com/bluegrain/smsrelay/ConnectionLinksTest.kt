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
    @Test fun stagingFallbackCannotOpenProductionAndProductionFallbackCannotOpenStaging() {
        val stage = "https://staging.example.test"
        assertEquals("ABCDEFG234", ConnectionLinks.code("smsrelay-staging://connect?code=ABCDE-FG234", stage, "smsrelay-staging"))
        assertNull(ConnectionLinks.code("smsrelay://connect?code=ABCDE-FG234", stage, "smsrelay-staging"))
        assertNull(ConnectionLinks.code("smsrelay-staging://connect?code=ABCDE-FG234", base))
        assertNull(ConnectionLinks.code("$base/connect?code=ABCDE-FG234", stage, "smsrelay-staging"))
        assertNull(ConnectionLinks.code("$stage/connect?code=ABCDE-FG234", base))
    }
    @Test fun malformedDuplicateAndCredentialValuesAreRejected() {
        assertNull(ConnectionLinks.code("$base/connect?code=ABCDE-FG234&code=ZZZZZ-ZZZZZ", base))
        assertNull(ConnectionLinks.code("$base/connect?code=%XX", base))
        assertNull(ConnectionLinks.code("$base/connect?code=smsr_not_a_comparison_code", base))
    }
    @Test fun onboardingLinksAreRestrictedToConfiguredOriginAndPublicPaths() {
        for (kind in listOf("register", "pair", "services", "connections")) {
            assertEquals(OnboardingLink(kind, "public-id"), ConnectionLinks.onboarding("$base/$kind/public-id", base))
        }
        assertEquals(OnboardingLink("oauth", "public-id"), ConnectionLinks.onboarding("$base/oauth/consent/public-id", base))
        for (link in listOf("http://relay.example.test/pair/id", "https://other.example.test/pair/id", "$base/pair/id?token=secret", "$base/pair/id#fragment", "$base/pair/%2f", "$base/pair/../services/id", "https://attacker@relay.example.test/pair/id", "$base:8443/pair/id")) {
            assertNull(ConnectionLinks.onboarding(link, base))
        }
    }
}
