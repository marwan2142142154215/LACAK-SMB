/**
 * Cache dan pembatalan permintaan API dashboard, dipasang sebagai adapter axios (lihat lib/api.js).
 *
 * Masalah yang diselesaikan: tiap pindah menu, halaman dimuat ulang dan meminta data yang sama lagi
 * (daftar device, site, peran, ...) walaupun baru saja diambil, dan permintaan yang tertinggal dari
 * halaman sebelumnya tetap berjalan.
 *
 * 1. Cache singkat untuk GET yang aman dipakai ulang. Panggilan identik yang bersamaan digabung jadi
 *    satu permintaan. Cache disimpan sebagai teks mentah JSON (axios mengurainya lagi per pemanggil),
 *    jadi satu halaman yang mengubah isi `response.data` tidak bisa merusak data halaman lain.
 *    Kunci memuat token login, jadi akun lain di tab yang sama tidak pernah melihat isi cache akun
 *    sebelumnya.
 * 2. Tulis (POST/PUT/PATCH/DELETE) mengosongkan cache, kecuali tulis rutin Live/Chat yang hanya
 *    menghapus data ringkasan Live.
 * 3. GET milik halaman tertentu (log, rekaman, lokasi, ...) dibatalkan saat pengguna pindah menu.
 *    Hasilnya tidak pernah selesai (bukan error), supaya blok `catch` halaman lama tidak memunculkan
 *    toast di halaman baru. Hanya GET yang dipanggil dari view yang dibatalkan, bukan yang dipanggil
 *    store atau layout.
 */

const SECOND = 1000

/** Data acuan yang jarang berubah (site, peran, aturan). */
const REFERENCE_TTL = 120 * SECOND
/** Daftar yang boleh sedikit lama: cukup untuk pindah menu bolak-balik. */
const LIST_TTL = 20 * SECOND
/** Ringkasan Live berubah cepat. */
const LIVE_OVERVIEW_TTL = 8 * SECOND

const REFERENCE_PATHS =
    /^\/(organizations|organizations\/mine|roles|roles\/options|work-shifts|geofence-rules|telegram-user-links|telegram-bindings)$/
const LIST_PATHS =
    /^\/(devices|users|leave-requests|announcements|attendance|work-alerts|dashboard-summary|live\/sites|work-alert-settings\/\d+)$/

/** GET dari view yang batal begitu pengguna pindah menu. */
const PAGE_SCOPED_PATHS =
    /^\/(activity-logs|live\/activity|live\/recordings|staff-locations|system\/status|apk-builds|devices\/\d+(\/commands)?)$/

/** Tulis rutin Live/Chat tidak boleh mengosongkan seluruh cache (heartbeat tiap 30 detik, dst). */
const ROUTINE_WRITE_PATHS = /^\/(live|chat|auth|telemetry)\//
/** Data yang ikut basi setelah tulis Live/Chat. */
const LIVE_DERIVED_PATHS = /^\/(live\/overview|live\/sites|dashboard-summary|briefings)$/

const hasParams = (params) => !!params && Object.keys(params).length > 0

/** Berapa lama (ms) GET ini boleh dipakai ulang; 0 = jangan di-cache. */
export function ttlFor(path, params) {
    if (REFERENCE_PATHS.test(path)) return REFERENCE_TTL
    if (LIST_PATHS.test(path)) return LIST_TTL
    if (path === '/live/overview') return LIVE_OVERVIEW_TTL
    // Daftar briefing tanpa parameter dipakai banner; versi with_people dipolling halamannya sendiri.
    if (path === '/briefings') return hasParams(params) ? 0 : LIST_TTL
    return 0
}

export const isPageScoped = (path) => PAGE_SCOPED_PATHS.test(path)

function pathOf(config) {
    const raw = String(config.url ?? '').split('?')[0]
    return raw.startsWith('/') ? raw : `/${raw}`
}

function stableParams(params) {
    if (!params) return ''
    const entries = Object.entries(params)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return JSON.stringify(entries)
}

function keyOf(config, path) {
    const token = String(config.headers?.Authorization ?? '')
    return [token, config.baseURL ?? '', path, stableParams(config.params)].join('|')
}

const isCanceled = (error) => error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError'

const snapshotOf = (response) => ({
    data: response.data,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    request: response.request,
})

/** Pelingkup halaman: `leave()` membatalkan semua permintaan milik halaman yang baru ditinggalkan. */
export function createPageScope() {
    let controller = new AbortController()
    return {
        signal: () => controller.signal,
        leave() {
            controller.abort()
            controller = new AbortController()
        },
    }
}

/**
 * @param baseAdapter adapter axios asli (fungsi yang menerima config dan mengembalikan response)
 * @param options.pageScope hasil createPageScope()
 * @param options.now sumber waktu (ms), diganti saat uji
 */
export function createApiAdapter(baseAdapter, { pageScope, now = Date.now } = {}) {
    const stored = new Map()
    const inflight = new Map()
    // Naik setiap ada tulis: hasil baca yang dimulai sebelum tulis tidak boleh masuk cache.
    let generation = 0

    function invalidate(path) {
        generation++
        if (ROUTINE_WRITE_PATHS.test(path)) {
            for (const [key, entry] of stored) {
                if (LIVE_DERIVED_PATHS.test(entry.path)) stored.delete(key)
            }
            return
        }
        stored.clear()
    }

    function prune() {
        if (stored.size < 200) return
        const current = now()
        for (const [key, entry] of stored) {
            if (entry.expiresAt <= current) stored.delete(key)
        }
    }

    function read(config, path, ttl) {
        const key = keyOf(config, path)
        const hit = config.fresh === true ? undefined : stored.get(key)
        if (hit && hit.expiresAt > now()) return Promise.resolve({ ...hit.snapshot, config })

        let pending = config.fresh === true ? undefined : inflight.get(key)
        if (!pending) {
            const startedAt = generation
            pending = baseAdapter(config)
                .then((response) => {
                    const snapshot = snapshotOf(response)
                    // Hanya teks mentah yang aman dibagi (tiap pemanggil mengurai salinannya sendiri).
                    if (typeof response.data === 'string' && generation === startedAt) {
                        stored.set(key, { path, expiresAt: now() + ttl, snapshot })
                        prune()
                    }
                    return snapshot
                })
                .finally(() => {
                    if (inflight.get(key) === pending) inflight.delete(key)
                })
            inflight.set(key, pending)
        }
        return pending.then((snapshot) => ({ ...snapshot, config }))
    }

    function pageScoped(config) {
        if (!pageScope || config.signal) return baseAdapter(config)
        const signal = pageScope.signal()
        config.signal = signal
        return baseAdapter(config).catch((error) => {
            if (signal.aborted && isCanceled(error)) return new Promise(() => {})
            throw error
        })
    }

    return function adapter(config) {
        const method = String(config.method ?? 'get').toLowerCase()
        const path = pathOf(config)

        if (method !== 'get') return baseAdapter(config).finally(() => invalidate(path))

        const ttl = ttlFor(path, config.params)
        if (ttl > 0) return read(config, path, ttl)
        if (isPageScoped(path)) return pageScoped(config)
        return baseAdapter(config)
    }
}
