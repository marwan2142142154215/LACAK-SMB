package com.lacaksmb.live.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color

// Dashboard web punya tema terang & gelap (style.css); di HP tema mengikuti
// pengaturan sistem. Komponen memakai token Base*/Accent* (Color.kt), jadi
// colorScheme Material di sini hanya untuk komponen bawaan (TextField, dll.).
private fun colorSchemeOf(p: LacakPalette): ColorScheme =
    (if (p.isDark) darkColorScheme() else lightColorScheme()).copy(
        primary = p.accent500,
        onPrimary = OnColor,
        primaryContainer = p.accent600,
        onPrimaryContainer = p.accent300,
        inversePrimary = p.accent600,

        secondary = p.copper500,
        onSecondary = OnColor,
        secondaryContainer = p.base800,
        onSecondaryContainer = p.copper400,

        tertiary = p.copper500,
        onTertiary = OnColor,
        tertiaryContainer = p.base800,
        onTertiaryContainer = p.copper400,

        background = p.base950,
        onBackground = p.base100,

        surface = p.base900,
        onSurface = p.base100,
        surfaceVariant = p.base850,
        onSurfaceVariant = p.base300,
        surfaceTint = p.accent500,

        surfaceContainerLowest = p.base950,
        surfaceContainerLow = p.base900,
        surfaceContainer = p.base850,
        surfaceContainerHigh = p.base800,
        surfaceContainerHighest = p.base700,

        inverseSurface = p.base100,
        inverseOnSurface = p.base950,

        error = p.danger500,
        onError = OnColor,
        errorContainer = p.danger600,
        onErrorContainer = p.danger400,

        outline = p.base700,
        outlineVariant = p.base800,
        scrim = Color.Black,
    )

@Composable
fun LacakLiveTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val palette = if (darkTheme) DarkPalette else LightPalette
    val colorScheme = remember(palette) { colorSchemeOf(palette) }
    CompositionLocalProvider(LocalLacakPalette provides palette) {
        MaterialTheme(colorScheme = colorScheme, shapes = LacakShapes, content = content)
    }
}
