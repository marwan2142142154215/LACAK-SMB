package com.lacaksmb.live.service

import android.graphics.Bitmap
import android.graphics.Matrix
import android.view.Surface
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
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

/**
 * Ganti background kamera siaran (blur / gambar), dipasang di track kamera
 * sejak dibuat. Mode [enabled] = false meneruskan frame apa adanya (tanpa
 * biaya), jadi staf bisa berganti pilihan di tengah siaran tanpa
 * menyalakan ulang kamera.
 *
 * Diadaptasi dari VirtualBackgroundVideoProcessor (livekit-android-track-
 * processors, Apache-2.0). Bedanya: masker orang/latar dihitung dari frame
 * kamera itu sendiri (ML Kit Selfie Segmentation, ~8x per detik), bukan dari
 * CameraX ImageAnalysis -- APK ini memakai kamera bawaan LiveKit (Camera2).
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
    private val segmenting = AtomicBoolean(false)
    @Volatile private var lastSegmentAt = 0L
    @Volatile private var lastMask: VirtualBackgroundTransformer.MaskHolder? = null

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
        segment(frame)
        // Berhasil masuk antrean = antrean pemilik frame; kalau masih sibuk, frame dilewati.
        if (!frames.tryEmit(frame)) frame.release()
    }

    override fun setSink(sink: VideoSink?) {
        targetSink = sink
    }

    /** Hitung masker baru dari frame ini, paling sering tiap [SEGMENT_INTERVAL_MS]. */
    private fun segment(frame: VideoFrame) {
        val now = System.currentTimeMillis()
        if (now - lastSegmentAt < SEGMENT_INTERVAL_MS || !segmenting.compareAndSet(false, true)) return
        lastSegmentAt = now
        val image = try {
            frame.toNv21InputImage()
        } catch (_: Exception) {
            segmenting.set(false)
            return
        }
        segmenter.process(image)
            .addOnSuccessListener { mask ->
                lastMask = VirtualBackgroundTransformer.MaskHolder(mask.width, mask.height, mask.buffer)
            }
            .addOnCompleteListener { segmenting.set(false) }
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

        frame.retain()
        surfaceTextureHelper.handler.post {
            if (backgroundImageNeedsUpdating) {
                transformer.backgroundImage = backgroundImage?.let { fitTo(it, frame) }
                backgroundImageNeedsUpdating = false
            }
            lastMask?.let { transformer.updateMask(it) }
            lastMask = null
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
        private const val SEGMENT_INTERVAL_MS = 120L
    }
}
