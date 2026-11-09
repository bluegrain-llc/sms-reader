package com.bluegrain.smsrelay

/** Deliberately conservative. Full SMS is never stored, returned, or logged. */
object CodeExtractor {
    private val candidate = Regex("(?<![A-Za-z0-9])[A-Za-z0-9]{4,10}(?![A-Za-z0-9])")
    fun validCode(value: String) = Regex("^(?=.*[0-9])[A-Za-z0-9]{4,10}$").matches(value)
    fun candidates(message: String): List<String> = candidate.findAll(message)
        .map { it.value }.filter { value -> value.any { it in '0'..'9' } }.distinct().toList()
}

/** A request-bound gate: extraction and upload are impossible before the system result approves. */
class ConsentGate {
    private var requestId: String? = null
    private var candidates: List<String> = emptyList()
    fun bind(id: String) { requestId = id; candidates = emptyList() }
    fun approve(id: String, message: String): List<String> {
        if (id != requestId) return emptyList()
        candidates = CodeExtractor.candidates(message)
        return candidates
    }
    fun permits(id: String, code: String) = requestId == id && code in candidates
    fun clear() { requestId = null; candidates = emptyList() }
}
