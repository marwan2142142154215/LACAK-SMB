package com.lacaksmb.tracker.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val DarkScheme = darkColorScheme(
    primary = Accent400,
    onPrimary = Base950,
    secondary = Accent500,
    background = Base950,
    onBackground = Base50,
    surface = Base900,
    onSurface = Base50,
    surfaceVariant = Base850,
    onSurfaceVariant = Base200,
    outline = Base700,
    error = Danger500,
)

// Aplikasi ini sengaja selalu gelap (senada web-dashboard), tidak mengikuti
// tema sistem — konteksnya aplikasi keamanan/pemantauan, bukan app konsumen
// biasa yang perlu light mode.
@Composable
fun LacakTrackerTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkScheme,
        content = content,
    )
}
