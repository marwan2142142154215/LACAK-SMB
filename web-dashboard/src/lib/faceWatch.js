import wasmBinaryPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url'
import wasmLoaderPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url'

import { createFaceState } from './faceState'

/**
 * Cek wajah di kamera staf yang sedang Live Kerja. Deteksi berjalan di
 * browser staf sendiri (MediaPipe Face Detector, model di /models) -- tidak
 * ada gambar yang dikirim ke server; yang dilaporkan hanya "wajah hilang"
 * (tidak ada wajah >= FACE_MISSING_AFTER_MS) dan "wajah kembali".
 * Kalau background kamera aktif, wajah juga dianggap hilang saat masker
 * background tidak menemukan orang -- penonton hanya melihat background.
 *
 * Frame diambil langsung dari track kamera (ImageCapture), jadi tetap jalan
 * walau tab dashboard sedang di latar belakang. Gagal dimuat = cek wajah
 * mati diam-diam; staf tidak pernah tercatat "wajah hilang" karena error.
 */
const CHECK_INTERVAL_MS = 1000
export const FACE_MISSING_AFTER_MS = 30_000
// Cek gagal terus selama ini (frame macet, model error) = status wajah tidak diketahui, "hilang" dicabut.
const UNKNOWN_AFTER_MS = 30_000
// grabFrame() Chrome kadang tidak pernah selesai (kamera dinyalakan ulang / track diganti). Tanpa
// batas waktu, cek berikutnya tertahan "sibuk" selamanya dan status wajah membeku.
const GRAB_TIMEOUT_MS = 3000
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
    let getPersonVisible = () => null
    let capture = null
    let busy = false
    let missing = false
    const state = createFaceState({ missingAfterMs: FACE_MISSING_AFTER_MS, unknownAfterMs: UNKNOWN_AFTER_MS })

    function setMissing(value) {
        if (missing === value) return
        missing = value
        onChange(value)
    }

    function grabFrame(imageCapture) {
        let timer = null
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('grabFrame macet')), GRAB_TIMEOUT_MS)
        })
        return Promise.race([imageCapture.grabFrame(), timeout]).finally(() => clearTimeout(timer))
    }

    async function check() {
        if (busy) return
        const track = getTrack()
        // Kamera mati / dibisukan: urusan status Camera off, bukan wajah.
        if (!track || track.readyState !== 'live' || track.muted || !track.enabled) {
            setMissing(state.cameraOff())
            return
        }
        busy = true
        try {
            const detector = await loadDetector()
            if (!capture || capture.track !== track) capture = new window.ImageCapture(track)
            const frame = await grabFrame(capture)
            const faces = detector.detect(frame).detections.length
            frame.close()
            // Wajah ada di kamera asli tapi background menutupi orangnya
            // (penonton hanya melihat background) = tetap dianggap hilang.
            setMissing(faces > 0 && getPersonVisible() !== false ? state.seen() : state.notSeen())
        } catch {
            // Frame belum siap / macet / model gagal dimuat: jangan tandai hilang; ImageCapture dibuat
            // ulang di cek berikutnya. Gagal terus = status tidak diketahui (lihat faceState.js).
            capture = null
            setMissing(state.failed())
        } finally {
            busy = false
        }
    }

    return {
        /**
         * Mulai memantau; [cameraTrack] mengembalikan MediaStreamTrack kamera
         * saat ini, [personVisible] (opsional) hasil masker background: false =
         * video yang tersiar tidak memperlihatkan orang.
         */
        start(cameraTrack, personVisible = () => null) {
            if (!('ImageCapture' in window)) return
            getTrack = cameraTrack
            getPersonVisible = personVisible
            if (timer) return
            state.reset()
            timer = setInterval(check, CHECK_INTERVAL_MS)
        },
        stop() {
            clearInterval(timer)
            timer = null
            getTrack = () => null
            getPersonVisible = () => null
            capture = null
            busy = false
            state.reset()
            missing = false
        },
        get missing() {
            return missing
        },
    }
}
