/*
 * Pesan galat sambungan video (LiveKit / WebRTC) yang bisa dipahami pengguna. Galat mentah seperti
 * "could not establish pc connection" artinya browser TIDAK berhasil membuka jalur video ke server
 * (hampir selalu karena jaringan memblokir UDP/WebRTC), bukan karena akun atau izin.
 */
const NETWORK_PATTERN = /pc connection|could not establish|ice\b|signal connection|failed to fetch|websocket|timeout/i

export const VIDEO_NETWORK_HINT =
    'Jalur video tidak bisa terbentuk. Biasanya jaringan ini memblokir WebRTC (Wi-Fi kantor/hotspot tertentu, VPN, atau ekstensi pemblokir WebRTC). Coba jaringan lain, matikan VPN/ekstensi, lalu coba lagi.'

/** Kembalikan pesan untuk toast: respons server kalau ada, galat jaringan video dijelaskan, selain itu apa adanya. */
export function connectErrorMessage(err) {
    const serverMessage = err?.response?.data?.message
    if (serverMessage) return serverMessage
    const raw = err?.message ?? 'Terjadi kesalahan'
    return NETWORK_PATTERN.test(raw) ? VIDEO_NETWORK_HINT : raw
}
