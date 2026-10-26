import wasmBinaryPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url'
import wasmLoaderPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url'

/**
 * Cek wajah di kamera staf yang sedang Live Kerja. Deteksi berjalan di
 * browser staf sendiri (MediaPipe Face Detector, model di /models) -- tidak
 * ada gambar yang dikirim ke server; yang dilaporkan hanya "wajah hilang"
 * (tidak ada wajah >= FACE_MISSING_AFTER_MS) dan "wajah kembali".
 *
 * Frame diambil langsung dari track kamera (ImageCapture), jadi tetap jalan
 * walau tab dashboard sedang di latar belakang. Gagal dimuat = cek wajah
 * mati diam-diam; staf tidak pernah tercatat "wajah hilang" karena error.
 */
const CHECK_INTERVAL_MS = 1000
export const FACE_MISSING_AFTER_MS = 30_000
const MODEL_PATH = '/models/blaze_face_short_range.tflite'

let detectorPromise = null

function loadDetector() {
    detectorPromise ??= (async () => {
        const { FaceDetector } = await import('@mediapipe/tasks-vision')
        return FaceDetector.createFromOptions(
            { wasmLoaderPath, wasmBinaryPath },
            {
                baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'CPU' },
                runningMode: 'IMAGE',
                minDetectionConfidence: 0.5,
            },
        )
    })().catch((err) => {
        detectorPromise = null
        throw err
    })
    return detectorPromise
}

/**
 * @param {(missing: boolean) => void} onChange dipanggil saat status wajah berubah
 */
export function createFaceWatch(onChange) {
    let timer = null
    let getTrack = () => null
    let capture = null
    let busy = false
    let lastSeen = 0
    let missing = false

    function setMissing(value) {
        if (missing === value) return
        missing = value
        onChange(value)
    }

    async function check() {
        if (busy) return
        const track = getTrack()
        // Kamera mati / dibisukan: urusan status Camera off, bukan wajah.
        if (!track || track.readyState !== 'live' || track.muted || !track.enabled) {
            lastSeen = Date.now()
            setMissing(false)
            return
        }
        busy = true
        try {
            const detector = await loadDetector()
            if (!capture || capture.track !== track) capture = new window.ImageCapture(track)
            const frame = await capture.grabFrame()
            const faces = detector.detect(frame).detections.length
            frame.close()
            if (faces > 0) {
                lastSeen = Date.now()
                setMissing(false)
            } else if (Date.now() - lastSeen >= FACE_MISSING_AFTER_MS) {
                setMissing(true)
            }
        } catch {
            // Frame belum siap / model gagal dimuat: lewati, jangan tandai hilang.
        } finally {
            busy = false
        }
    }

    return {
        /** Mulai memantau; [cameraTrack] mengembalikan MediaStreamTrack kamera saat ini. */
        start(cameraTrack) {
            if (!('ImageCapture' in window)) return
            getTrack = cameraTrack
            if (timer) return
            lastSeen = Date.now()
            timer = setInterval(check, CHECK_INTERVAL_MS)
        },
        stop() {
            clearInterval(timer)
            timer = null
            getTrack = () => null
            capture = null
            lastSeen = 0
            missing = false
        },
        get missing() {
            return missing
        },
    }
}
