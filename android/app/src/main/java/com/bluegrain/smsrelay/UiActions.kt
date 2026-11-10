package com.bluegrain.smsrelay

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update

internal class UiActions(private val state: MutableStateFlow<RelayUiState>, private val error: (String) -> Unit) {
    suspend fun run(waitForIdle: Boolean = false, silent: Boolean = false, block: suspend () -> Unit) {
        if (waitForIdle) while (state.value.busy) state.first { !it.busy }
        if (state.value.busy) return
        state.update { it.copy(busy = true, error = if (silent) it.error else null) }
        try { block() } catch (e: CancellationException) { throw e }
        catch (e: ApiFailure) { if (!silent) error(e.reason.replace('_', ' ')) }
        catch (_: Exception) { if (!silent) error("Could not connect. Check your network and try again.") }
        finally { state.update { it.copy(busy = false) } }
    }

    suspend fun credentials(block: suspend () -> Unit) = run(waitForIdle = true, block = block)
}
