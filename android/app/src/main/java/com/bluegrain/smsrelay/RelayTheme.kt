package com.bluegrain.smsrelay

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Paper = Color(0xFFF5F8F7)
private val Signal = Color(0xFF006B5E)
private val Graphite = Color(0xFF142D29)
@Composable
fun RelayTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme(
        primary = Color(0xFF8AD6C3), onPrimary = Color(0xFF00382E),
        background = Color(0xFF0E1916), surface = Color(0xFF172621), surfaceVariant = Color(0xFF263A32),
        onBackground = Color(0xFFE4EEE9), onSurface = Color(0xFFE4EEE9), onSurfaceVariant = Color(0xFFAFCCC0),
        secondary = Color(0xFFAFCCC0), secondaryContainer = Color(0xFF263F35), onSecondaryContainer = Color(0xFFD4EAE2),
        outline = Color(0xFF78968A), outlineVariant = Color(0xFF3A5147),
    ) else lightColorScheme(primary = Signal, onPrimary = Color.White,
        background = Paper, surface = Color.White, surfaceVariant = Color(0xFFE5EEEA),
        onBackground = Graphite, onSurface = Graphite, onSurfaceVariant = Color(0xFF4B625D), error = Color(0xFFAC3228),
        secondary = Signal, secondaryContainer = Color(0xFFD4EAE2), onSecondaryContainer = Graphite,
        outline = Color(0xFF7B948B), outlineVariant = Color(0xFFCFDDD6))
    MaterialTheme(colorScheme = colors, content = content)
}
