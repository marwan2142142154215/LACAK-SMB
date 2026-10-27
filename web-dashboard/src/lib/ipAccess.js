import api from '@/lib/api'

/**
 * Boleh/tidaknya IP perangkat ini membuka halaman login (whitelist IP di
 * Pengaturan). Hanya penentu tampilan: penegakan sebenarnya tetap di backend
 * saat login & di setiap request. Dicache sebentar supaya pindah-pindah
 * halaman tidak memanggil backend berkali-kali.
 */
const CACHE_MS = 15_000

let cached = null // { at, result: { ip, allowed } }

/** @returns {Promise<{ ip: string, allowed: boolean } | null>} null = backend tidak bisa dihubungi */
export async function checkIpAccess({ fresh = false } = {}) {
    if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.result
    try {
        const response = await api.get('/auth/ip-check')
        cached = { at: Date.now(), result: response.data.data }
        return cached.result
    } catch {
        return null
    }
}

/** Lupakan hasil cek terakhir (mis. backend baru saja menolak IP ini). */
export function forgetIpAccess() {
    cached = null
}
