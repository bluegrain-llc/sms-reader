package com.bluegrain.smsrelay

import java.net.URI
import java.net.URLDecoder

data class OnboardingLink(val kind: String, val id: String)

object ConnectionLinks {
    fun onboarding(link: String, serviceUrl: String): OnboardingLink? = runCatching {
        val uri = URI(link)
        val expected = URI(serviceUrl)
        if (uri.scheme != "https" || expected.scheme != "https" || uri.host == null || !uri.host.equals(expected.host, true) ||
            uri.port !in listOf(-1, 443) || uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
        val match = Regex("^/(register|pair|services|connections|oauth/consent)/([a-zA-Z0-9_-]{1,128})$").matchEntire(uri.rawPath) ?: return null
        OnboardingLink(if (match.groupValues[1] == "oauth/consent") "oauth" else match.groupValues[1], match.groupValues[2])
    }.getOrNull()

    fun code(link: String, serviceUrl: String): String? = runCatching {
        val uri = URI(link)
        val expectedHost = runCatching { URI(serviceUrl).host }.getOrNull()
        val supported = (uri.scheme == "smsrelay" && uri.host == "connect") ||
            (uri.scheme == "https" && expectedHost != null && uri.host.equals(expectedHost, true) && uri.path == "/connect" && uri.port in listOf(-1, 443))
        if (!supported || uri.userInfo != null) return null
        val codes = uri.rawQuery.orEmpty().split('&').mapNotNull { field ->
            val parts = field.split('=', limit = 2)
            if (parts.size == 2 && parts[0] == "code") URLDecoder.decode(parts[1], "UTF-8") else null
        }
        if (codes.size != 1) return null
        codes.single().uppercase().replace("-", "").replace(" ", "")
            .takeIf { Regex("^[A-HJ-NP-Z2-9]{10}$").matches(it) }
    }.getOrNull()
}
