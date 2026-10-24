// Mengubah log kejadian kerja (GET /live/activity) jadi potongan waktu per
// status untuk tiap staf -- dasar "pita shift", grafik 7 hari, dan rincian
// staf di halaman Aktivitas user. Status di tiap kejadian adalah status
// SETELAH kejadian itu (lihat App\Services\WorkPresence), jadi satu potongan
// berlangsung dari satu kejadian sampai kejadian berikutnya.

/** Kelompok untuk grafik: masalah layar/kamera/koneksi digabung jadi satu warna. */
export const CHART_GROUPS = [
    { key: 'working', label: 'Kerja', bar: 'bg-st-working', statuses: ['working'] },
    { key: 'idle', label: 'Idle', bar: 'bg-st-idle', statuses: ['idle'] },
    { key: 'break', label: 'Istirahat', bar: 'bg-st-break', statuses: ['break'] },
    {
        key: 'issue',
        label: 'Bermasalah',
        bar: 'bg-st-screen',
        statuses: ['screen_off', 'camera_off', 'alert', 'disconnected'],
    },
]

const GROUP_OF = Object.fromEntries(CHART_GROUPS.flatMap((group) => group.statuses.map((status) => [status, group.key])))

/**
 * @param {Array<{user_id:number, status:string, occurred_at:string}>} events urut waktu
 * @param {Record<number, string>} initialStatuses status tiap staf tepat sebelum `from`
 * @returns {Map<number, Array<{status:string, start:number, end:number}>>} offline tidak disimpan
 */
export function buildSegments(events, initialStatuses, from, to, now = Date.now()) {
    const end = Math.min(to, now)
    const byUser = new Map()
    const state = new Map(Object.entries(initialStatuses ?? {}).map(([userId, status]) => [Number(userId), { status, since: from }]))

    const push = (userId, status, start, stop) => {
        if (status === 'offline' || stop <= start) return
        const list = byUser.get(userId) ?? []
        const last = list[list.length - 1]
        if (last && last.status === status && last.end === start) last.end = stop
        else list.push({ status, start, end: stop })
        byUser.set(userId, list)
    }

    for (const event of events) {
        const at = Math.min(new Date(event.occurred_at).getTime(), end)
        const current = state.get(event.user_id) ?? { status: 'offline', since: from }
        push(event.user_id, current.status, current.since, at)
        state.set(event.user_id, { status: event.status, since: at })
        if (!byUser.has(event.user_id)) byUser.set(event.user_id, [])
    }

    for (const [userId, current] of state) push(userId, current.status, current.since, end)

    return byUser
}

/** Potong segmen ke rentang [start, end). */
export function clipSegments(segments, start, end) {
    return (segments ?? [])
        .filter((segment) => segment.end > start && segment.start < end)
        .map((segment) => ({ ...segment, start: Math.max(segment.start, start), end: Math.min(segment.end, end) }))
}

/** Total milidetik per kelompok grafik. */
export function groupTotals(segments) {
    const totals = { working: 0, idle: 0, break: 0, issue: 0 }
    for (const segment of segments ?? []) {
        const group = GROUP_OF[segment.status]
        if (group) totals[group] += segment.end - segment.start
    }
    return totals
}
