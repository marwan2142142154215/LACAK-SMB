// Status kerja staf Live Kerja -- kunci sama dengan App\Services\WorkPresence
// di backend. Urutan objek = urutan tampil di papan status.
export const WORK_STATUS = {
    working: { label: 'Working', emoji: '🟢', led: 'text-emerald-400', chip: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' },
    idle: { label: 'Idle', emoji: '🟡', led: 'text-yellow-400', chip: 'border-yellow-400/30 bg-yellow-400/10 text-yellow-300' },
    break: { label: 'Break', emoji: '🔵', led: 'text-sky-400', chip: 'border-sky-400/30 bg-sky-400/10 text-sky-300' },
    disconnected: { label: 'Disconnected', emoji: '🔴', led: 'text-red-500', chip: 'border-red-500/30 bg-red-500/10 text-red-400' },
    screen_off: { label: 'Screen off', emoji: '🟠', led: 'text-orange-400', chip: 'border-orange-400/30 bg-orange-400/10 text-orange-300' },
    camera_off: { label: 'Camera off', emoji: '🟣', led: 'text-violet-400', chip: 'border-violet-400/30 bg-violet-400/10 text-violet-300' },
    offline: { label: 'Offline', emoji: '⚫', led: 'text-base-500 led-off', chip: 'border-base-700 bg-base-850 text-base-400' },
    alert: { label: 'Alert', emoji: '🚨', led: 'text-danger-400', chip: 'border-danger-500/40 bg-danger-500/15 text-danger-400' },
}

export function workStatus(key) {
    return WORK_STATUS[key] ?? WORK_STATUS.offline
}

// Nama kejadian di log kerja (tipe dari backend -> teks di tabel).
export const WORK_EVENT_LABELS = {
    login: 'Login',
    logout: 'Logout',
    work_start: 'Mulai kerja',
    work_end: 'Selesai kerja',
    screen_start: 'Screen run',
    screen_stop: 'Screen stop',
    camera_start: 'Camera run',
    camera_stop: 'Camera stop',
    break_start: 'Break',
    break_end: 'Lanjut kerja',
    idle_start: 'Idle',
    idle_end: 'Aktif lagi',
    disconnected: 'Terputus',
    reconnected: 'Tersambung lagi',
    timeout: 'Sesi ditutup (tanpa sinyal)',
}

/** 4500 -> "1j 15m" */
export function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds ?? 0))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    return hours ? `${hours}j ${String(minutes).padStart(2, '0')}m` : `${minutes}m`
}
