import { ref } from 'vue'

// Background kamera (blur / gambar), diproses di browser pemilik kamera lewat
// @livekit/track-processors -- yang dikirim ke penonton sudah berupa video
// dengan background diganti. Dipakai Briefing dan Live Kerja.
const SEGMENTER_MODEL = '/models/selfie_segmenter.tflite'
const BLUR_RADIUS = 12

/** Browser ini sanggup mengganti background? (butuh WebGL + insertable streams / OffscreenCanvas) */
export async function backgroundSupported() {
    try {
        const { supportsBackgroundProcessors } = await import('@livekit/track-processors')
        return supportsBackgroundProcessors()
    } catch {
        return false
    }
}

/**
 * Track kamera ASLI dari LocalVideoTrack. Begitu background dipasang,
 * `track.mediaStreamTrack` mengembalikan hasil olahan -- cek kamera mati &
 * cek wajah harus tetap membaca kamera sebenarnya.
 */
export function rawCameraTrack(track) {
    return track?._mediaStreamTrack ?? track?.mediaStreamTrack ?? null
}

function load(storageKey) {
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey))
        if (saved?.mode === 'blur' || (saved?.mode === 'image' && saved.image)) return saved
    } catch {
        // Penyimpanan browser tidak bisa dibaca: pakai kamera asli.
    }
    return { mode: 'none', image: null }
}

function save(storageKey, value) {
    try {
        localStorage.setItem(storageKey, JSON.stringify(value))
    } catch {
        // Gambar terlalu besar / penyimpanan diblokir: tetap berlaku untuk sesi ini.
    }
}

/**
 * Pilihan background satu tempat (diingat per browser di `storageKey`).
 * `getTrack()` mengembalikan LocalVideoTrack kamera saat ini, atau null.
 */
export function createCameraBackground(storageKey, getTrack) {
    const background = ref(load(storageKey))
    let processor = null

    /** Pasang pilihan saat ini ke kamera (kalau kamera menyala). */
    async function apply() {
        const track = getTrack()
        if (!track) return
        const { mode, image } = background.value
        if (mode === 'none') {
            if (track.getProcessor()) await track.stopProcessor()
            processor = null
            return
        }
        const options =
            mode === 'blur' ? { mode: 'background-blur', blurRadius: BLUR_RADIUS } : { mode: 'virtual-background', imagePath: image }
        if (processor && track.getProcessor() === processor) {
            await processor.switchTo(options)
            return
        }
        const { BackgroundProcessor } = await import('@livekit/track-processors')
        processor = BackgroundProcessor({ ...options, assetPaths: { modelAssetPath: SEGMENTER_MODEL } })
        await track.setProcessor(processor)
    }

    async function set(next) {
        background.value = next
        save(storageKey, next)
        await apply()
    }

    /** Room ditutup: processor lama ikut track yang sudah berhenti. */
    function reset() {
        processor = null
    }

    return { background, apply, set, reset }
}
