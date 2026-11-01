package com.lacaksmb.live.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// Token warna gaya "modern bersih" — disinkronkan manual dengan
// web-dashboard/src/style.css (@theme dan :root[data-theme='light']).
// Sama seperti web, nama token tetap dan nilainya dibalik per tema: Base950
// selalu latar halaman, Base50 selalu teks paling tegas. Tema mengikuti
// pengaturan HP (lihat LacakLiveTheme di Theme.kt).

@Immutable
data class LacakPalette(
    val base950: Color,
    val base900: Color,
    val base850: Color,
    val base800: Color,
    val base700: Color,
    val base600: Color,
    val base500: Color,
    val base400: Color,
    val base300: Color,
    val base200: Color,
    val base100: Color,
    val base50: Color,
    val accent600: Color,
    val accent500: Color,
    val accent400: Color,
    val accent300: Color,
    val copper600: Color,
    val copper500: Color,
    val copper400: Color,
    val danger600: Color,
    val danger500: Color,
    val danger400: Color,
    val warning500: Color,
    val warning400: Color,
    val stWorking: Color,
    val stBreak: Color,
    val stScreen: Color,
    val stCamera: Color,
    val isDark: Boolean,
)

val DarkPalette = LacakPalette(
    base950 = Color(0xFF09090B),
    base900 = Color(0xFF111113),
    base850 = Color(0xFF18181B),
    base800 = Color(0xFF222226),
    base700 = Color(0xFF2E2E33),
    base600 = Color(0xFF3F3F46),
    base500 = Color(0xFF71717A),
    base400 = Color(0xFFA1A1AA),
    base300 = Color(0xFFC4C4CB),
    base200 = Color(0xFFDCDCE1),
    base100 = Color(0xFFECECEF),
    base50 = Color(0xFFFAFAFA),
    accent600 = Color(0xFF3B6CF6),
    accent500 = Color(0xFF4F7DFF),
    accent400 = Color(0xFF7AA0FF),
    accent300 = Color(0xFFA6C0FF),
    copper600 = Color(0xFF0D9488),
    copper500 = Color(0xFF14B8A6),
    copper400 = Color(0xFF2DD4BF),
    danger600 = Color(0xFFDC2626),
    danger500 = Color(0xFFEF4444),
    danger400 = Color(0xFFF87171),
    warning500 = Color(0xFFE0A12E),
    warning400 = Color(0xFFF5BD4F),
    stWorking = Color(0xFF34D399),
    stBreak = Color(0xFF38BDF8),
    stScreen = Color(0xFFFB923C),
    stCamera = Color(0xFFA78BFA),
    isDark = true,
)

val LightPalette = LacakPalette(
    base950 = Color(0xFFF6F7F9),
    base900 = Color(0xFFFFFFFF),
    base850 = Color(0xFFF3F4F6),
    base800 = Color(0xFFE8EAEE),
    base700 = Color(0xFFDCDFE5),
    base600 = Color(0xFFB8BDC7),
    base500 = Color(0xFF6B7280),
    base400 = Color(0xFF525866),
    base300 = Color(0xFF3B404B),
    base200 = Color(0xFF272B34),
    base100 = Color(0xFF16191F),
    base50 = Color(0xFF0A0B0D),
    accent600 = Color(0xFF1D48D8),
    accent500 = Color(0xFF2B5CF0),
    accent400 = Color(0xFF1F4FD6),
    accent300 = Color(0xFF1A43B8),
    copper600 = Color(0xFF0B5F58),
    copper500 = Color(0xFF0F766E),
    copper400 = Color(0xFF0D6B64),
    danger600 = Color(0xFFB91C1C),
    danger500 = Color(0xFFDC2626),
    danger400 = Color(0xFFC42121),
    warning500 = Color(0xFFB7790B),
    warning400 = Color(0xFF8F5D00),
    stWorking = Color(0xFF047857),
    stBreak = Color(0xFF0369A1),
    stScreen = Color(0xFFC2410C),
    stCamera = Color(0xFF6D28D9),
    isDark = false,
)

val LocalLacakPalette = staticCompositionLocalOf { DarkPalette }

/** Teks di atas tombol berwarna (aksen/bahaya): selalu putih, kedua tema. */
val OnColor = Color(0xFFFFFFFF)

val Base950: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base950
val Base900: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base900
val Base850: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base850
val Base800: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base800
val Base700: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base700
val Base600: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base600
val Base500: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base500
val Base400: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base400
val Base300: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base300
val Base200: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base200
val Base100: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base100
val Base50: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.base50

val Accent600: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.accent600
val Accent500: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.accent500
val Accent400: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.accent400
val Accent300: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.accent300

val Copper600: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.copper600
val Copper500: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.copper500
val Copper400: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.copper400

val Danger600: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.danger600
val Danger500: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.danger500
val Danger400: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.danger400

val Warning500: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.warning500
val Warning400: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.warning400

// Warna status kerja, sama dengan --color-st-* di web (titik & badge status).
val StWorking: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.stWorking
val StBreak: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.stBreak
val StScreen: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.stScreen
val StCamera: Color @Composable @ReadOnlyComposable get() = LocalLacakPalette.current.stCamera
