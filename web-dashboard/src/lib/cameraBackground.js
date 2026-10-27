import { ref } from 'vue'

import wasmBinaryPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url'
import wasmLoaderPath from '../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url'

// Background kamera (blur / gambar), diproses di browser pemilik kamera lewat
// @livekit/track-processors (pipeline gambar) + MediaPipe milik dashboard
// (segmentasi) -- yang dikirim ke penonton sudah berupa video dengan
// background diganti. Dipakai Briefing dan Live Kerja.
const SEGMENTER_MODEL = '/models/selfie_segmenter.tflite'
const BLUR_RADIUS = 12
// Bobot masker frame sebelumnya: makin besar makin halus, tapi makin lambat mengikuti gerak.
const MASK_SMOOTHING = 0.3
// Lebar frame untuk segmentasi (px). Model selfie_segmenter bekerja di 256 px.
const SEGMENT_WIDTH = 256
// Porsi frame minimal yang dianggap "orang" supaya penonton masih melihat
// seseorang. Di bawah ini video siaran praktis hanya berisi background.
const MIN_PERSON_COVERAGE = 0.02
// Hasil masker lebih tua dari ini = processor berhenti / macet -> tidak dipakai.
const COVERAGE_STALE_MS = 3000

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

/**
 * Segmenter orang/latar milik dashboard sendiri (MediaPipe di
 * node_modules, model di /models -- tanpa CDN), berjalan di CPU dengan
 * frame diperkecil ke [SEGMENT_WIDTH] px. Sengaja TIDAK memakai segmenter GPU
 * bawaan paket: segmenter itu berbagi konteks WebGL dengan pipeline gambar,
 * dan di sebagian GPU laptop (Intel/AMD bawaan, driver Windows) hasilnya
 * rusak -- hampir seluruh badan dianggap latar.
 */
async function createSegmenter() {
    const { ImageSegmenter } = await import('@mediapipe/tasks-vision')
    const segmenter = await ImageSegmenter.createFromOptions(
        { wasmLoaderPath, wasmBinaryPath },
        {
            baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate: 'CPU' },
            runningMode: 'VIDEO',
            outputCategoryMask: false,
            outputConfidenceMasks: true,
        },
    )
    const segmentFull = segmenter.segmentForVideo.bind(segmenter)
    const small = new OffscreenCanvas(SEGMENT_WIDTH, SEGMENT_WIDTH)
    const smallContext = small.getContext('2d')
    // Paket memanggil segmentForVideo(frame 720p, ...) -- perkecil dulu.
    segmenter.segmentForVideo = (frame, timestamp, callback) => {
        const height = Math.round((SEGMENT_WIDTH * frame.displayHeight) / frame.displayWidth)
        if (small.height !== height) small.height = height
        smallContext.drawImage(frame, 0, 0, SEGMENT_WIDTH, height)
        return segmentFull(small, timestamp, callback)
    }
    return segmenter
}

/**
 * Seperti BackgroundProcessor() bawaan paket, tapi tepinya lebih halus:
 * bawaan memakai masker 0/1 (categoryMask) sehingga tepi rambut & bahu
 * bergerigi. Di sini dipakai masker peluang (confidenceMasks, 0..1),
 * dihaluskan sedikit antar-frame supaya tepinya tidak berkedip, lalu
 * diteruskan ke pipeline WebGL paket yang sama (blur tepi + komposit).
 * Masker untuk pipeline itu = peluang LATAR (1 - peluang orang).
 */
async function createSmoothProcessor(options, onCoverage) {
    const { BackgroundProcessorWrapper, BackgroundTransformer, VideoTransformer } = await import('@livekit/track-processors')

    class SmoothBackgroundTransformer extends BackgroundTransformer {
        // init bawaan paket diganti: segmenter-nya sendiri (lihat createSegmenter),
        // bukan segmenter GPU paket yang berbagi konteks WebGL dengan pipeline.
        async init(initOptions) {
            await VideoTransformer.prototype.init.call(this, initOptions)
            this.smoothMask = null
            this.maskBytes = null
            this.maskTexture = null
            this.imageSegmenter = await createSegmenter()
            if (this.options.imagePath) await this.loadAndSetBackground(this.options.imagePath).catch(() => {})
            if (typeof this.options.blurRadius === 'number') this.gl?.setBlurRadius(this.options.blurRadius)
            this.gl?.setBackgroundDisabled(this.options.backgroundDisabled ?? false)
        }

        // Dipanggil paket tepat setelah segmentasi frame ini, sebelum frame digambar.
        async updateMask() {
            const person = this.segmentationResults?.confidenceMasks?.[0]
            const context = this.canvas?.getContext('webgl2')
            if (!person || !context || !this.gl) return
            const { width, height } = person
            const values = person.getAsFloat32Array()
            const count = width * height
            if (this.smoothMask?.length !== count) {
                this.smoothMask = null
                this.maskBytes = new Uint8Array(count)
            }
            const previous = this.smoothMask
            const smooth = previous ?? new Float32Array(count)
            let personPixels = 0
            for (let i = 0; i < count; i++) {
                const background = 1 - values[i]
                smooth[i] = previous ? background * (1 - MASK_SMOOTHING) + previous[i] * MASK_SMOOTHING : background
                this.maskBytes[i] = smooth[i] * 255
                if (smooth[i] < 0.5) personPixels++
            }
            this.smoothMask = smooth
            onCoverage?.(personPixels / count)

            const bound = context.getParameter(context.TEXTURE_BINDING_2D)
            if (!this.maskTexture) {
                this.maskTexture = context.createTexture()
                context.bindTexture(context.TEXTURE_2D, this.maskTexture)
                context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR)
                context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR)
                context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE)
                context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE)
            }
            context.bindTexture(context.TEXTURE_2D, this.maskTexture)
            context.pixelStorei(context.UNPACK_ALIGNMENT, 1)
            context.texImage2D(context.TEXTURE_2D, 0, context.R8, width, height, 0, context.RED, context.UNSIGNED_BYTE, this.maskBytes)
            context.bindTexture(context.TEXTURE_2D, bound)
            this.gl.updateMask(this.maskTexture)
        }

        async destroy(destroyOptions) {
            if (this.maskTexture) this.canvas?.getContext('webgl2')?.deleteTexture(this.maskTexture)
            this.maskTexture = null
            this.smoothMask = null
            await super.destroy(destroyOptions)
        }
    }

    const { mode, ...rest } = options
    const transformer = new SmoothBackgroundTransformer({
        ...(mode === 'background-blur' ? { blurRadius: rest.blurRadius } : { imagePath: rest.imagePath }),
    })
    return new BackgroundProcessorWrapper(transformer, 'background-processor')
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
    // Porsi orang di masker frame terakhir (lihat personVisible).
    let coverage = null
    const recordCoverage = (value) => (coverage = { value, at: Date.now() })

    /** Pasang pilihan saat ini ke kamera (kalau kamera menyala). */
    async function apply() {
        const track = getTrack()
        if (!track) return
        const { mode, image } = background.value
        if (mode === 'none') {
            if (track.getProcessor()) await track.stopProcessor()
            processor = null
            coverage = null
            return
        }
        const options =
            mode === 'blur' ? { mode: 'background-blur', blurRadius: BLUR_RADIUS } : { mode: 'virtual-background', imagePath: image }
        if (processor && track.getProcessor() === processor) {
            await processor.switchTo(options)
            return
        }
        processor = await createSmoothProcessor(options, recordCoverage)
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
        coverage = null
    }

    /**
     * Apakah penonton masih melihat orang di video siaran? false = masker
     * background tidak menemukan orang (yang tersiar hanya background),
     * null = background mati / belum ada hasil masker -> tidak bisa dinilai.
     */
    function personVisible() {
        if (background.value.mode === 'none' || !processor || !coverage) return null
        if (Date.now() - coverage.at > COVERAGE_STALE_MS) return null
        return coverage.value >= MIN_PERSON_COVERAGE
    }

    return { background, apply, set, reset, personVisible }
}
