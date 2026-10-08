package com.lacaksmb.master.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Dashboard web tidak punya mode terang (color-scheme: dark dipaksa di
// style.css) — Compose mengikuti pola yang sama di sini: selalu dark,
// isSystemInDarkTheme() diabaikan dengan sengaja.
private val LacakDarkColors = darkColorScheme(
    primary = Accent500,
    onPrimary = Base950,
    primaryContainer = Accent600,
    onPrimaryContainer = Accent300,
    inversePrimary = Accent600,

    secondary = Copper500,
    onSecondary = Base950,
    secondaryContainer = Base800,
    onSecondaryContainer = Copper400,

    tertiary = Copper500,
    onTertiary = Base950,
    tertiaryContainer = Base800,
    onTertiaryContainer = Copper400,

    background = Base950,
    onBackground = Base100,

    surface = Base900,
    onSurface = Base100,
    surfaceVariant = Base850,
    onSurfaceVariant = Base300,
    surfaceTint = Accent500,

    surfaceContainerLowest = Base950,
    surfaceContainerLow = Base900,
    surfaceContainer = Base850,
    surfaceContainerHigh = Base800,
    surfaceContainerHighest = Base700,

    inverseSurface = Base100,
    inverseOnSurface = Base950,

    error = Danger500,
    onError = Base50,
    errorContainer = Danger600,
    onErrorContainer = Danger400,

    outline = Base700,
    outlineVariant = Base800,
    scrim = Color.Black,
)

@Composable
fun LacakMasterTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = LacakDarkColors, shapes = LacakShapes, content = content)
}
