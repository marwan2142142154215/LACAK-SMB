package com.lacaksmb.live.service

import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import livekit.org.webrtc.VideoFrame
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Cek wajah di kamera depan selama Live Kerja (ML Kit, berjalan di HP --
 * tidak ada gambar yang dikirim ke server). Satu frame per detik diperiksa;
 * tidak ada wajah >= [MISSING_AFTER_MS] = "wajah hilang". Hanya dicatat di
 * log kerja, tidak mengubah status maupun jam kerja.
 *
 * Sama dengan web-dashboard/src/lib/faceWatch.js.
 */
class FaceWatch(private val onChange: (missing: Boolean) -> Unit) {
    private val detector = FaceDetection.getClient(
        FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
            .setMinFaceSize(0.15f)
            .build(),
    )
    private val busy = AtomicBoolean(false)

    @Volatile private var lastCheck = 0L
    @Volatile private var lastSeen = System.currentTimeMillis()
    @Volatile var missing = false
        private set

    /** Dipanggil dari VideoSink kamera (thread kamera); frame hanya berlaku selama panggilan ini. */
    fun onFrame(frame: VideoFrame) {
        val now = System.currentTimeMillis()
        if (now - lastCheck < CHECK_INTERVAL_MS || !busy.compareAndSet(false, true)) return
        lastCheck = now
        val image = try {
            frame.toNv21InputImage()
        } catch (_: Exception) {
            busy.set(false)
            return
        }
        detector.process(image)
            .addOnSuccessListener { faces -> update(faces.isNotEmpty()) }
            .addOnCompleteListener { busy.set(false) }
    }

    /** Kamera mati / macet: urusan status Camera off, bukan wajah. */
    fun cameraUnavailable() {
        lastSeen = System.currentTimeMillis()
        setMissing(false)
    }

    fun reset() {
        lastSeen = System.currentTimeMillis()
        lastCheck = 0
        missing = false
    }

    fun close() = detector.close()

    private fun update(faceFound: Boolean) {
        val now = System.currentTimeMillis()
        if (faceFound) {
            lastSeen = now
            setMissing(false)
        } else if (now - lastSeen >= MISSING_AFTER_MS) {
            setMissing(true)
        }
    }

    private fun setMissing(value: Boolean) {
        if (missing == value) return
        missing = value
        onChange(value)
    }

    companion object {
        private const val CHECK_INTERVAL_MS = 1_000L
        const val MISSING_AFTER_MS = 30_000L
    }
}
