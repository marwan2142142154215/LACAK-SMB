import wasmBinaryPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url'
import wasmLoaderPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url'

import { createFaceState } from './faceState'

/**
 * Cek wajah di kamera staf yang sedang Live Kerja (wajah, atau badan orang kalau wajahnya tidak
 * menghadap kamera -- lihat personPresent). Deteksi berjalan di
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
// Minimal cek berturut-turut tanpa wajah sebelum "hilang" -- lihat minMisses di faceState.js.
const MIN_MISSES = 3
// grabFrame() Chrome kadang tidak pernah selesai (kamera dinyalakan ulang / track diganti). Tanpa
// batas waktu, cek berikutnya tertahan "sibuk" selamanya dan status wajah membeku.
const GRAB_TIMEOUT_MS = 3000
const MODEL_PATH = '/models/blaze_face_short_range.tflite'
const SEGMENTER_MODEL = '/models/selfie_segmenter.tflite'
// Model wajah bekerja di 128 px dan dibuat untuk wajah dekat yang menghadap kamera. Cadangannya
// segmentasi orang di 256 px: staf yang menunduk ke keyboard / menoleh ke monitor lain tetap
// terhitung ADA selama badannya terlihat (dulu dianggap "wajah hilang" padahal masih duduk).
const SEGMENT_WIDTH = 256
// Porsi frame minimal yang berisi orang supaya dianggap ada (orang duduk di depan kamera biasanya 20-50%).
const PERSON_MIN_COVERAGE = 0.08

let detectorPromise = null
let segmenterPromise = null

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

function loadSegmenter() {
    segmenterPromise ??= (async () => {
        const { ImageSegmenter } = await import('@mediapipe/tasks-vision')
        return ImageSegmenter.createFromOptions(
            { wasmLoaderPath, wasmBinaryPath },
            {
                baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate: 'CPU' },
                runningMode: 'IMAGE',
                outputCategoryMask: false,
                outputConfidenceMasks: true,
            },
        )
    })().catch((err) => {
        segmenterPromise = null
        throw err
    })
    return segmenterPromise
}

/** Gambar ulang [frame] (atau potongannya) ke kanvas kecil. */
function drawTo(canvas, frame, sx, sy, sw, sh, width, height) {
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    canvas.getContext('2d').drawImage(frame, sx, sy, sw, sh, 0, 0, width, height)
    return canvas
}

/**
 * Ada orang di depan kamera? Urutan dari yang termurah:
 * 1. wajah di frame utuh;
 * 2. wajah di potongan persegi tengah -- frame 16:9 yang diperkecil ke 128 px membuat wajah yang
 *    agak jauh terlalu kecil; potongan tengah membuatnya kira-kira 2x lebih besar;
 * 3. badan orang (segmentasi) -- menunduk / menoleh tetap terhitung ada.
 */
async function personPresent(detector, frame, canvas) {
    if (detector.detect(frame).detections.length > 0) return true

    const side = Math.min(frame.width, frame.height)
    const square = drawTo(canvas.square, frame, (frame.width - side) / 2, (frame.height - side) / 2, side, side, 256, 256)
    if (detector.detect(square).detections.length > 0) return true

    const segmenter = await loadSegmenter().catch(() => null)
    if (!segmenter) return false
    const height = Math.round((SEGMENT_WIDTH * frame.height) / frame.width)
    const small = drawTo(canvas.small, frame, 0, 0, frame.width, frame.height, SEGMENT_WIDTH, height)
    const result = segmenter.segment(small)
    try {
        const values = result.confidenceMasks?.[0]?.getAsFloat32Array()
        if (!values?.length) return false
        let person = 0
        for (const value of values) if (value >= 0.5) person++
        return person / values.length >= PERSON_MIN_COVERAGE
    } finally {
        result.close?.()
    }
}

/**
 * @param {(missing: boolean) => void} onChange dipanggil saat status wajah berubah
 */
export function createFaceWatch(onChange) {
    let timer = null
    let getTrack = () => null
    let getPersonVisible = () => null
    let isPaused = () => false
    let capture = null
    let busy = false
    const canvas = { square: new OffscreenCanvas(256, 256), small: new OffscreenCanvas(SEGMENT_WIDTH, 144) }
    let missing = false
    const state = createFaceState({
        missingAfterMs: FACE_MISSING_AFTER_MS,
        unknownAfterMs: UNKNOWN_AFTER_MS,
        minMisses: MIN_MISSES,
    })

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
        // Istirahat: staf boleh meninggalkan meja -- tidak dicek, hitungan mulai lagi saat lanjut kerja.
        if (isPaused()) {
            setMissing(state.reset())
            return
        }
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
            let present = false
            try {
                present = await personPresent(detector, frame, canvas)
            } finally {
                frame.close()
            }
            // Orang ada di kamera asli tapi background menutupinya
            // (penonton hanya melihat background) = tetap dianggap hilang.
            setMissing(present && getPersonVisible() !== false ? state.seen() : state.notSeen())
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
         * video yang tersiar tidak memperlihatkan orang, [paused] (opsional) true = jangan cek
         * (staf sedang istirahat).
         */
        start(cameraTrack, personVisible = () => null, paused = () => false) {
            if (!('ImageCapture' in window)) return
            getTrack = cameraTrack
            getPersonVisible = personVisible
            isPaused = paused
            if (timer) return
            state.reset()
            timer = setInterval(check, CHECK_INTERVAL_MS)
        },
        stop() {
            clearInterval(timer)
            timer = null
            getTrack = () => null
            getPersonVisible = () => null
            isPaused = () => false
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
