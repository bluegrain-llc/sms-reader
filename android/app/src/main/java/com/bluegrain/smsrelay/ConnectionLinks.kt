package com.bluegrain.smsrelay

import java.net.URI
import java.net.URLDecoder

object ConnectionLinks {
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
