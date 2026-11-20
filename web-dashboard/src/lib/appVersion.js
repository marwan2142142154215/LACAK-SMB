/**
 * Logika murni untuk "versi baru dashboard tersedia": mendeteksi versi baru dari index.html, mengenali
 * kegagalan memuat berkas halaman yang sudah diganti deploy, dan memutuskan kapan boleh memuat ulang.
 * Dipakai composables/useAppUpdate.js dan router/index.js.
 */

const ENTRY_PATTERN = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/i

/** Alamat berkas JS utama di index.html (nama berkasnya berubah tiap build), atau null. */
export function entryScriptOf(html) {
    const match = ENTRY_PATTERN.exec(html ?? '')
    return match ? match[1] : null
}

const CHUNK_ERROR_PATTERN =
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i

/** Berkas halaman gagal dimuat (biasanya karena sudah diganti deploy baru dan tab ini masih versi lama). */
export function isChunkLoadError(error) {
    return CHUNK_ERROR_PATTERN.test(String(error?.message ?? error ?? ''))
}

/** Nama event yang dikirim router saat berkas halaman gagal dimuat (didengar useAppUpdate). */
export const CHUNK_ERROR_EVENT = 'lacak:chunk-error'

/**
 * Boleh memuat ulang otomatis sekarang? Tidak pernah saat sibuk (siaran/briefing berjalan); selain itu
 * hanya bila tab tersembunyi atau pengguna diam cukup lama, supaya isian yang sedang diketik tidak hilang.
 */
export function canReloadNow({ busy, hidden, idleMs, minIdleMs }) {
    if (busy) return false
    return hidden || idleMs >= minIdleMs
}

/** Pengaman putaran muat ulang: jangan memuat ulang lagi kalau baru saja dilakukan. */
export function reloadAllowed({ lastReloadAt, now, minGapMs }) {
    return !lastReloadAt || now - lastReloadAt >= minGapMs
}
