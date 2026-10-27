import { isIP } from 'node:net'

/**
 * IP asli klien untuk panggilan gateway -> backend atas nama user. Backend
 * menegakkan whitelist IP di setiap request terautentikasi; tanpa ini semua
 * panggilan relay terlihat datang dari server gateway sendiri.
 *
 * Gateway di belakang nginx di server yang sama: X-Forwarded-For hanya
 * dipercaya kalau koneksi langsungnya dari loopback, dan yang diambil entri
 * TERAKHIR (yang ditambahkan nginx sendiri -- entri sebelumnya bisa dikarang
 * klien). Backend mempercayai X-Forwarded-For dari loopback, jadi nilai ini
 * yang dipakai untuk mencocokkan whitelist (BACKEND_API_URL harus alamat lokal).
 */

type Handshake = { address: string; headers: Record<string, string | string[] | undefined> }

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/

export function clientIpOf(handshake: Handshake): string {
    const direct = handshake.address ?? ''
    if (!LOOPBACK.test(direct)) return direct

    const header = handshake.headers['x-forwarded-for']
    const raw = Array.isArray(header) ? header.join(',') : (header ?? '')
    const last = raw.split(',').at(-1)?.trim() ?? ''
    return isIP(last) ? last : direct
}

// token -> IP klien + jumlah socket aktif yang memakai token itu.
const byToken = new Map<string, { ip: string; sockets: number }>()

/** Dipanggil saat handshake socket ber-token; pasangkan dengan forgetClientIp(). */
export function rememberClientIp(token: string, ip: string) {
    const entry = byToken.get(token)
    byToken.set(token, { ip, sockets: (entry?.sockets ?? 0) + 1 })
}

export function forgetClientIp(token: string) {
    const entry = byToken.get(token)
    if (!entry) return
    if (entry.sockets <= 1) byToken.delete(token)
    else entry.sockets -= 1
}

/** Header untuk panggilan backend dengan token user ini. */
export function userHeaders(token: string): Record<string, string> {
    const ip = byToken.get(token)?.ip
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(ip ? { 'X-Forwarded-For': ip } : {}),
    }
}
