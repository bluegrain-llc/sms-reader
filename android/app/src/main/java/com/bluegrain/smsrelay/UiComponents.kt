package com.bluegrain.smsrelay

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

@Composable
fun ScreenToolbar(title: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleLarge)
    }
}

@Composable
fun SwitchRow(label: String, checked: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = { onToggle() }),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RefreshableList(refreshing: Boolean, onRefresh: () -> Unit, modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp), spacing: Arrangement.Vertical = Arrangement.Top,
    content: LazyListScope.() -> Unit) {
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(modifier.fillMaxSize(), contentPadding = contentPadding, verticalArrangement = spacing, content = content)
    }
}

internal fun requestStatusLabel(status: String) = when (status) {
    "queued" -> "Waiting for another request"
    "pending_phone" -> "Opening listener"
    "ready" -> "Listening for your SMS"
    "awaiting_consent" -> "Review Android’s consent dialog"
    "completed" -> "Approved code shared"
    "denied" -> "Sharing declined"
    "cancelled" -> "Request cancelled"
    "expired" -> "Request expired"
    "failed" -> "Request could not finish"
    else -> status.replace('_', ' ')
}
