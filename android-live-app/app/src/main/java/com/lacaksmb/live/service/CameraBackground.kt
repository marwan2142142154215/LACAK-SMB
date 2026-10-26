package com.lacaksmb.live.service

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.net.Uri
import android.os.Build
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/** Pilihan background kamera Live Kerja. */
sealed interface BackgroundChoice {
    data object None : BackgroundChoice
    data object Blur : BackgroundChoice
    /** Gradasi bawaan, indeks ke [CameraBackground.PRESETS]. */
    data class Preset(val index: Int) : BackgroundChoice
    /** Gambar pilihan staf dari galeri (disalin ke penyimpanan aplikasi). */
    data object Custom : BackgroundChoice
}

/**
 * Pilihan background disimpan di HP (SharedPreferences + satu berkas gambar
 * di penyimpanan aplikasi), dipakai lagi di siaran berikutnya. Warna gradasi
 * sama dengan dashboard web (BackgroundPicker.vue).
 */
object CameraBackground {
    data class Preset(val name: String, val colors: IntArray)

    val PRESETS = listOf(
        Preset("Biru kantor", intArrayOf(0xFF0F2A4A.toInt(), 0xFF1F5F8B.toInt(), 0xFF9CC3DD.toInt())),
        Preset("Abu netral", intArrayOf(0xFF2B2F36.toInt(), 0xFF5B626D.toInt(), 0xFFC9CDD3.toInt())),
        Preset("Hangat", intArrayOf(0xFF4A2412.toInt(), 0xFFB8643A.toInt(), 0xFFF1CFA8.toInt())),
        Preset("Hijau tenang", intArrayOf(0xFF10332B.toInt(), 0xFF2F7A63.toInt(), 0xFFBFE0D2.toInt())),
    )

    private const val PREFS = "live_background"
    private const val KEY_MODE = "mode"
    private const val KEY_PRESET = "preset"
    private const val CUSTOM_FILE = "live_background.jpg"
    private const val MAX_SIDE = 1280

    fun load(context: Context): BackgroundChoice {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return when (prefs.getString(KEY_MODE, "none")) {
            "blur" -> BackgroundChoice.Blur
            "preset" -> BackgroundChoice.Preset(prefs.getInt(KEY_PRESET, 0).coerceIn(PRESETS.indices))
            "custom" -> if (customFile(context).exists()) BackgroundChoice.Custom else BackgroundChoice.None
            else -> BackgroundChoice.None
        }
    }

    fun save(context: Context, choice: BackgroundChoice) {
        val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        when (choice) {
            BackgroundChoice.None -> editor.putString(KEY_MODE, "none")
            BackgroundChoice.Blur -> editor.putString(KEY_MODE, "blur")
            is BackgroundChoice.Preset -> editor.putString(KEY_MODE, "preset").putInt(KEY_PRESET, choice.index)
            BackgroundChoice.Custom -> editor.putString(KEY_MODE, "custom")
        }
        editor.apply()
    }

    /** Salin gambar dari galeri (diperkecil ke 1280px) sebagai background pilihan. Panggil di luar main thread. */
    fun importCustom(context: Context, uri: Uri) {
        val decoded = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
                val scale = MAX_SIDE / max(info.size.width, info.size.height).toFloat()
                if (scale < 1f) decoder.setTargetSize((info.size.width * scale).roundToInt(), (info.size.height * scale).roundToInt())
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it) }
                ?: throw IllegalArgumentException("Gambar tidak bisa dibaca")
        }
        customFile(context).outputStream().use { decoded.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        decoded.recycle()
    }

    /** Gambar latar untuk [choice]; null = tanpa gambar (kamera asli / blur). */
    fun bitmapFor(context: Context, choice: BackgroundChoice): Bitmap? = when (choice) {
        is BackgroundChoice.Preset -> gradient(PRESETS[choice.index].colors)
        BackgroundChoice.Custom -> BitmapFactory.decodeFile(customFile(context).path)
        else -> null
    }

    fun gradient(colors: IntArray, width: Int = 1280, height: Int = 720): Bitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val paint = Paint().apply {
            shader = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), colors, null, Shader.TileMode.CLAMP)
        }
        Canvas(bitmap).drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
        return bitmap
    }

    fun customFile(context: Context) = File(context.filesDir, CUSTOM_FILE)
}
