import dayjs from 'dayjs'

// Wajah hilang baru masuk log setelah 5 menit (FACE_LOG_MIN_SECONDS di server).
export const FACE_LOG_MIN_MS = 5 * 60_000

/**
 * Selang "wajah hilang" dari kejadian satu staf (urut waktu): face_lost ->
 * face_back, atau sampai sesi selesai. `back` = cara berakhirnya: 'face'
 * (wajah terlihat lagi), 'ended' (selesai kerja / logout), null (masih hilang
 * sekarang). Hanya selang minimal FACE_LOG_MIN_MS yang ditampilkan (sama
 * dengan server, yang menghapus catatan lebih singkat); yang masih
 * berlangsung muncul begitu mencapai batas itu.
 */
export function faceGaps(events, endMs) {
    return allFaceGaps(events, endMs).filter((gap) => gap.end - gap.start >= FACE_LOG_MIN_MS)
}

function allFaceGaps(events, endMs) {
    const gaps = []
    let lostAt = null
    for (const event of events) {
        const at = new Date(event.occurred_at).getTime()
        if (event.type === 'face_lost') lostAt ??= at
        else if (lostAt !== null && (event.type === 'face_back' || event.status === 'offline')) {
            gaps.push({ start: lostAt, end: at, back: event.type === 'face_back' ? 'face' : 'ended' })
            lostAt = null
        }
    }
    if (lostAt !== null) gaps.push({ start: lostAt, end: Math.max(lostAt, endMs), back: null })
    return gaps
}

export function faceBackLabel(gap) {
    if (gap.back === 'face') return dayjs(gap.end).format('HH:mm:ss')
    if (gap.back === 'ended') return `Selesai kerja ${dayjs(gap.end).format('HH:mm')}`
    return 'Belum terlihat'
}
