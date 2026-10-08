package com.lacaksmb.master.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Primary = Color(0xFF0F766E)
private val PrimaryDark = Color(0xFF14B8A6)

private val LightColors = lightColorScheme(primary = Primary, secondary = Color(0xFF334155))
private val DarkColors = darkColorScheme(primary = PrimaryDark, secondary = Color(0xFF94A3B8))

@Composable
fun LacakMasterTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, content = content)
}
