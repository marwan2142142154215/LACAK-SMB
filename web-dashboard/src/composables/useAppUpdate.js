import { onBeforeUnmount, onMounted, ref } from 'vue'

import { CHUNK_ERROR_EVENT, canReloadNow, entryScriptOf, reloadAllowed } from '@/lib/appVersion'
import { createVisiblePoller } from '@/lib/visiblePoll'

/** Cek versi baru: tab terlihat tiap 5 menit, tersembunyi tiap 10 menit (satu berkas statis kecil). */
const CHECK_VISIBLE_MS = 5 * 60_000
const CHECK_HIDDEN_MS = 10 * 60_000
/** Muat ulang otomatis disebar acak dalam rentang ini supaya ratusan tab tidak memuat ulang bersamaan. */
const RELOAD_SPREAD_MS = 5 * 60_000
/** Tab yang terlihat baru dimuat ulang otomatis kalau penggunanya diam selama ini. */
const IDLE_BEFORE_RELOAD_MS = 3 * 60_000
const ATTEMPT_EVERY_MS = 15_000
/** Jeda minimum antar muat ulang otomatis di tab yang sama (pengaman putaran). */
const AUTO_RELOAD_GAP_MS = 10 * 60_000
const URGENT_RELOAD_GAP_MS = 2 * 60_000
const LAST_RELOAD_KEY = 'lacak_auto_reload_at'
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart']

function readLastReload() {
    try {
        return Number(sessionStorage.getItem(LAST_RELOAD_KEY)) || 0
    } catch {
        return 0
    }
}

function currentEntry() {
    return document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null
}

/**
 * Deploy baru mengganti berkas dashboard. Tab yang dibiarkan terbuka sepanjang hari tetap memakai
 * versi lama (dan bisa gagal membuka halaman yang berkasnya sudah diganti), jadi di sini:
 * - versi baru terdeteksi dari index.html, lalu tab dimuat ulang otomatis KALAU aman: tidak sedang siaran
 *   atau briefing, dan tab tersembunyi / penggunanya diam beberapa menit;
 * - kalau tidak aman, `available` menyala dan AppShell menampilkan tombol "Muat ulang";
 * - berkas halaman yang gagal dimuat (tanda versi lama) memuat ulang segera bila aman.
 *
 * @param isBusy fungsi: true bila memuat ulang akan memutus sesuatu (siaran Live, briefing)
 * @param canAutoReload false = hanya tampilkan tombol, tidak pernah memuat ulang sendiri (mis. di APK)
 */
export function useAppUpdate({ isBusy, canAutoReload = true }) {
    const available = ref(false)
    let lastInputAt = Date.now()
    let reloadAt = 0
    let attemptTimer = null

    function reloadNow() {
        window.location.reload()
    }

    /** Memuat ulang kalau pengaman putaran mengizinkan. */
    function guardedReload(minGapMs) {
        if (!reloadAllowed({ lastReloadAt: readLastReload(), now: Date.now(), minGapMs })) return false
        try {
            sessionStorage.setItem(LAST_RELOAD_KEY, String(Date.now()))
        } catch {
            // Tanpa penyimpanan, pengaman putaran tidak bisa bekerja: jangan memuat ulang otomatis.
            return false
        }
        reloadNow()
        return true
    }

    function tryAutoReload() {
        if (!available.value || !canAutoReload || Date.now() < reloadAt) return
        const allowed = canReloadNow({
            busy: isBusy(),
            hidden: document.hidden,
            idleMs: Date.now() - lastInputAt,
            minIdleMs: IDLE_BEFORE_RELOAD_MS,
        })
        if (allowed) guardedReload(AUTO_RELOAD_GAP_MS)
    }

    function markAvailable() {
        available.value = true
        if (reloadAt) return
        reloadAt = Date.now() + Math.random() * RELOAD_SPREAD_MS
        attemptTimer = setInterval(tryAutoReload, ATTEMPT_EVERY_MS)
    }

    async function check() {
        if (import.meta.env.DEV || available.value) return
        try {
            const response = await fetch(`${import.meta.env.BASE_URL}index.html`, { cache: 'no-store', credentials: 'omit' })
            if (!response.ok) return
            const latest = entryScriptOf(await response.text())
            const current = currentEntry()
            if (latest && current && latest !== current) markAvailable()
        } catch {
            // Offline / server sibuk: dicoba lagi pada pengecekan berikutnya.
        }
    }

    /** Berkas halaman gagal dimuat: tab ini versi lama. Segera muat ulang bila aman, selain itu tampilkan tombol. */
    function onChunkError() {
        // Dijadwalkan juga (bukan hanya dicoba sekali): kalau sedang sibuk, dicoba lagi begitu siaran selesai.
        markAvailable()
        if (canAutoReload && !isBusy()) guardedReload(URGENT_RELOAD_GAP_MS)
    }

    const poller = createVisiblePoller(check, { visibleMs: CHECK_VISIBLE_MS, hiddenMs: CHECK_HIDDEN_MS })
    const onInput = () => (lastInputAt = Date.now())

    onMounted(() => {
        for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true })
        window.addEventListener(CHUNK_ERROR_EVENT, onChunkError)
        // Vite mengirim event ini bila berkas yang dimuat dinamis (halaman/modul) gagal diambil.
        window.addEventListener('vite:preloadError', onChunkError)
        poller.start()
    })

    onBeforeUnmount(() => {
        for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput)
        window.removeEventListener(CHUNK_ERROR_EVENT, onChunkError)
        window.removeEventListener('vite:preloadError', onChunkError)
        poller.stop()
        clearInterval(attemptTimer)
    })

    return { available, reloadNow }
}
