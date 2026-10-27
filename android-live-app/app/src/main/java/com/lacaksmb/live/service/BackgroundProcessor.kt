package com.lacaksmb.live.service

import android.graphics.Bitmap
import android.graphics.Matrix
import android.view.Surface
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import io.livekit.android.room.track.video.NoDropVideoProcessor
import io.livekit.android.track.processing.video.VirtualBackgroundTransformer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import livekit.org.webrtc.EglBase
import livekit.org.webrtc.EglRenderer
import livekit.org.webrtc.SurfaceTextureHelper
import livekit.org.webrtc.VideoFrame
import livekit.org.webrtc.VideoSink
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/**
 * Ganti background kamera siaran (blur / gambar), dipasang di track kamera
 * sejak dibuat. Mode [enabled] = false meneruskan frame apa adanya (tanpa
 * biaya), jadi staf bisa berganti pilihan di tengah siaran tanpa
 * menyalakan ulang kamera.
 *
 * Diadaptasi dari VirtualBackgroundVideoProcessor (livekit-android-track-
 * processors, Apache-2.0). Bedanya: masker orang/latar dihitung dari frame
 * kamera itu sendiri (ML Kit Selfie Segmentation), bukan dari CameraX
 * ImageAnalysis -- APK ini memakai kamera bawaan LiveKit (Camera2).
 *
 * Supaya tepi rapi: tiap frame disegmentasi DULU lalu digambar dengan
 * maskernya sendiri (tidak ada masker "tertinggal" saat staf bergerak), dan
 * masker dihaluskan sedikit antar-frame ([MASK_SMOOTHING]) supaya tepinya
 * tidak berkedip. Kalau HP lambat, frame dilewati (fps turun), bukan
 * tepinya yang meleset.
 *
 * Frame tetap mengalir dari kamera: kalau kamera berhenti, frame olahan ikut
 * berhenti, jadi watchdog kamera & cek wajah tetap bekerja seperti biasa.
 */
class BackgroundProcessor(eglBase: EglBase) : NoDropVideoProcessor() {

    private var targetSink: VideoSink? = null
    private val segmenter = Segmentation.getClient(
        SelfieSegmenterOptions.Builder()
            .setDetectorMode(SelfieSegmenterOptions.STREAM_MODE)
            .build(),
    )
    // Masker hasil penghalusan; beberapa buffer bergantian karena masker
    // dibaca thread GL setelah frame berikutnya mulai diproses.
    private val maskBuffers = arrayOfNulls<ByteBuffer>(MASK_BUFFERS)
    private var maskIndex = 0
    private var previousMask: ByteBuffer? = null
    private var previousMaskSize = 0 to 0

    private var lastRotation = 0
    private var lastWidth = 0
    private var lastHeight = 0
    private val surfaceTextureHelper = SurfaceTextureHelper.create("LacakBackground", eglBase.eglBaseContext)
    private val surface = Surface(surfaceTextureHelper.surfaceTexture)
    private val transformer = VirtualBackgroundTransformer(blurRadius = BLUR_RADIUS)
    private val eglRenderer = EglRenderer(BackgroundProcessor::class.java.simpleName).apply {
        init(eglBase.eglBaseContext, EglBase.CONFIG_PLAIN, transformer)
        createEglSurface(surface)
    }

    private val scope = CoroutineScope(Dispatchers.Default)
    private val frames = MutableSharedFlow<VideoFrame>(
        replay = 0,
        extraBufferCapacity = 1,
        onBufferOverflow = BufferOverflow.SUSPEND,
    )

    /** false = kamera asli (frame diteruskan tanpa diolah). */
    @Volatile var enabled = false

    // Porsi "orang" di masker frame terakhir (lihat personVisible).
    @Volatile private var coverage = 0f
    @Volatile private var coverageAt = 0L

    /**
     * Apakah penonton masih melihat orang di video siaran? false = masker
     * tidak menemukan orang (yang tersiar hanya background), null = background
     * mati / belum ada masker baru -> tidak bisa dinilai. Dipakai FaceWatch.
     */
    fun personVisible(): Boolean? {
        if (!enabled || System.currentTimeMillis() - coverageAt > COVERAGE_STALE_MS) return null
        return coverage >= MIN_PERSON_COVERAGE
    }

    /** Gambar latar; null = blur. */
    var backgroundImage: Bitmap? = null
        set(value) {
            field = value
            backgroundImageNeedsUpdating = true
        }
    @Volatile private var backgroundImageNeedsUpdating = false

    init {
        scope.launch {
            frames.collect { frame ->
                processFrame(frame)
                frame.release()
            }
        }
    }

    override fun onCapturerStarted(started: Boolean) {
        if (started) {
            surfaceTextureHelper.stopListening()
            surfaceTextureHelper.startListening { frame -> targetSink?.onFrame(frame) }
        }
    }

    override fun onCapturerStopped() {
        surfaceTextureHelper.stopListening()
    }

    override fun onFrameCaptured(frame: VideoFrame) {
        if (!enabled) {
            targetSink?.onFrame(frame)
            return
        }
        try {
            frame.retain()
        } catch (_: Exception) {
            return
        }
        // Berhasil masuk antrean = antrean pemilik frame; kalau masih sibuk, frame dilewati.
        if (!frames.tryEmit(frame)) frame.release()
    }

    override fun setSink(sink: VideoSink?) {
        targetSink = sink
    }

    /**
     * Masker orang/latar untuk [frame] ini (diperkecil ke ~360p dulu -- model
     * bekerja di 256 px, jadi tidak ada detail yang hilang), dihaluskan
     * dengan masker sebelumnya. null = segmentasi gagal / terlalu lama.
     */
    private fun maskFor(frame: VideoFrame): VirtualBackgroundTransformer.MaskHolder? {
        val buffer = frame.buffer
        val scale = minOf(1f, SEGMENT_HEIGHT / minOf(buffer.width, buffer.height).toFloat())
        val scaled = buffer.cropAndScale(
            0, 0, buffer.width, buffer.height,
            (buffer.width * scale).roundToInt(), (buffer.height * scale).roundToInt(),
        )
        val image = try {
            VideoFrame(scaled, frame.rotation, frame.timestampNs).toNv21InputImage()
        } catch (_: Exception) {
            return null
        } finally {
            scaled.release()
        }
        val mask = try {
            Tasks.await(segmenter.process(image), SEGMENT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            return null
        }

        val size = mask.width to mask.height
        val count = mask.width * mask.height
        val target = maskBuffers[maskIndex]?.takeIf { it.capacity() == count * 4 }
            ?: ByteBuffer.allocateDirect(count * 4).order(ByteOrder.nativeOrder()).also { maskBuffers[maskIndex] = it }
        maskIndex = (maskIndex + 1) % MASK_BUFFERS

        val fresh = mask.buffer.order(ByteOrder.nativeOrder()).asFloatBuffer()
        val out = target.asFloatBuffer()
        val previous = previousMask?.takeIf { previousMaskSize == size }?.asFloatBuffer()
        var personPixels = 0
        for (i in 0 until count) {
            val value = fresh.get(i)
            val smooth = if (previous == null) value else value * (1f - MASK_SMOOTHING) + previous.get(i) * MASK_SMOOTHING
            out.put(i, smooth)
            if (smooth >= 0.5f) personPixels++
        }
        coverage = personPixels / count.toFloat()
        coverageAt = System.currentTimeMillis()
        previousMask = target
        previousMaskSize = size
        return VirtualBackgroundTransformer.MaskHolder(mask.width, mask.height, target)
    }

    private fun processFrame(frame: VideoFrame) {
        if (lastRotation != frame.rotation) {
            lastRotation = frame.rotation
            backgroundImageNeedsUpdating = true
        }
        if (lastWidth != frame.rotatedWidth || lastHeight != frame.rotatedHeight) {
            surfaceTextureHelper.setTextureSize(frame.rotatedWidth, frame.rotatedHeight)
            lastWidth = frame.rotatedWidth
            lastHeight = frame.rotatedHeight
            backgroundImageNeedsUpdating = true
        }

        val mask = maskFor(frame)
        frame.retain()
        surfaceTextureHelper.handler.post {
            if (backgroundImageNeedsUpdating) {
                transformer.backgroundImage = backgroundImage?.let { fitTo(it, frame) }
                backgroundImageNeedsUpdating = false
            }
            // Masker frame ini dipasang tepat sebelum frame ini digambar.
            mask?.let { transformer.updateMask(it) }
            eglRenderer.onFrame(frame)
            frame.release()
        }
    }

    /** Potong gambar latar ke rasio frame (tengah) dan putar sesuai rotasi kamera. */
    private fun fitTo(image: Bitmap, frame: VideoFrame): Bitmap {
        val imageAspect = image.width / image.height.toFloat()
        val targetAspect = frame.rotatedWidth / frame.rotatedHeight.toFloat()
        var sx = 0
        var sy = 0
        var sWidth = image.width
        var sHeight = image.height
        if (imageAspect > targetAspect) {
            sWidth = (image.height * targetAspect).roundToInt()
            sx = ((image.width - sWidth) / 2f).roundToInt()
        } else {
            sHeight = (image.width / targetAspect).roundToInt()
            sy = ((image.height - sHeight) / 2f).roundToInt()
        }
        val matrix = Matrix().apply { postRotate(-frame.rotation.toFloat()) }
        return Bitmap.createBitmap(image, sx, sy, sWidth, sHeight, matrix, true)
    }

    fun dispose() {
        scope.cancel()
        segmenter.close()
        surfaceTextureHelper.stopListening()
        surfaceTextureHelper.dispose()
        surface.release()
        eglRenderer.release()
        transformer.release()
    }

    companion object {
        private const val BLUR_RADIUS = 16f
        /** Tinggi gambar untuk segmentasi (px); model ML Kit sendiri bekerja di 256 px. */
        private const val SEGMENT_HEIGHT = 360f
        private const val SEGMENT_TIMEOUT_MS = 250L
        /** Bobot masker sebelumnya: 0 = tanpa penghalusan, makin besar makin halus tapi makin lambat mengikuti gerak. */
        private const val MASK_SMOOTHING = 0.3f
        private const val MASK_BUFFERS = 3
        /** Porsi frame minimal yang dianggap orang; di bawahnya video praktis hanya background. */
        private const val MIN_PERSON_COVERAGE = 0.02f
        /** Masker lebih tua dari ini = pemrosesan berhenti -> tidak dipakai. */
        private const val COVERAGE_STALE_MS = 3_000L
    }
}
