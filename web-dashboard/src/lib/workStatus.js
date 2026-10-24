// Status kerja staf Live Kerja -- kunci sama dengan App\Services\WorkPresence
// di backend. Urutan objek = urutan tampil di papan status.
export const WORK_STATUS = {
    working: { label: 'Working', emoji: '🟢', led: 'text-st-working', chip: 'border-st-working/30 bg-st-working/10 text-st-working' },
    idle: { label: 'Idle', emoji: '🟡', led: 'text-st-idle', chip: 'border-st-idle/30 bg-st-idle/10 text-st-idle' },
    break: { label: 'Break', emoji: '🔵', led: 'text-st-break', chip: 'border-st-break/30 bg-st-break/10 text-st-break' },
    disconnected: {
        label: 'Disconnected',
        emoji: '🔴',
        led: 'text-st-disconnected',
        chip: 'border-st-disconnected/30 bg-st-disconnected/10 text-st-disconnected',
    },
    screen_off: { label: 'Screen off', emoji: '🟠', led: 'text-st-screen', chip: 'border-st-screen/30 bg-st-screen/10 text-st-screen' },
    camera_off: { label: 'Camera off', emoji: '🟣', led: 'text-st-camera', chip: 'border-st-camera/30 bg-st-camera/10 text-st-camera' },
    offline: { label: 'Offline', emoji: '⚫', led: 'text-base-500 led-off', chip: 'border-base-700 bg-base-850 text-base-400' },
    alert: { label: 'Alert', emoji: '🚨', led: 'text-danger-400', chip: 'border-danger-500/40 bg-danger-500/10 text-danger-400' },
}

// Status yang perlu ditindaklanjuti penonton (dihitung jadi "Perlu perhatian").
export const ATTENTION_STATUSES = ['alert', 'disconnected', 'camera_off', 'screen_off']

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
