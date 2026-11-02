/**
 * Status kerja Live Kerja -- padanan PERSIS WorkPresence::statusOf() di
 * backend-api. Urutan prioritas: offline -> disconnected -> break -> alert
 * (kamera & layar sama-sama mati) -> camera_off -> screen_off -> idle ->
 * working. Ubah keduanya bersamaan kalau aturannya berubah.
 */

export type WorkStatus =
    | 'working'
    | 'idle'
    | 'break'
    | 'disconnected'
    | 'screen_off'
    | 'camera_off'
    | 'offline'
    | 'alert'

/** Heartbeat dikirim tiap 30 detik; lewat dari ini staf dianggap terputus. */
export const DISCONNECTED_AFTER_SECONDS = 75

/** Kamera & layar sama-sama mati lebih lama dari ini setelah mulai kerja -> ALERT. */
export const ALERT_GRACE_SECONDS = 60

/** Kolom sesi yang dilaporkan staf -> [kejadian saat jadi true, saat jadi false]. */
export const STATE_EVENTS = {
    camera_active: ['camera_start', 'camera_stop'],
    screen_active: ['screen_start', 'screen_stop'],
    on_break: ['break_start', 'break_end'],
    idle: ['idle_start', 'idle_end'],
    // Cek wajah: hanya kejadian log, tidak mengubah status kerja.
    face_missing: ['face_lost', 'face_back'],
} as const

export type StateColumn = keyof typeof STATE_EVENTS

/**
 * Wajah hilang baru dicatat di log kalau berlangsung minimal selama ini
 * (dihitung dari face_lost). Sama dengan backend-adonis WorkPresence.ts.
 */
export const FACE_LOG_MIN_SECONDS = 5 * 60

export type WorkSessionRow = {
    id: number
    user_id: number
    // NULL = siaran Ruang pusat (penyiar yang tidak terikat site).
    organization_id: number | null
    // Peran tempat siaran dicatat; room status = site + peran (lihat LiveHub.liveRoom).
    live_role: string | null
    started_at: Date
    last_heartbeat_at: Date
    ended_at: Date | null
    disconnected_at: Date | null
    camera_active: boolean
    screen_active: boolean
    on_break: boolean
    idle: boolean
    face_missing: boolean
    // Sesi iPhone (Safari tidak bisa membagikan layar): layar tidak wajib. Tidak ada = false.
    camera_only?: boolean
    // Peran pemegang izin live.screen-optional: layar boleh ditutup. Tidak ada = false.
    screen_optional?: boolean
}

export function statusOf(session: WorkSessionRow | null, now: Date = new Date()): WorkStatus {
    if (!session || session.ended_at) {
        return 'offline'
    }

    const secondsAgo = (date: Date) => (now.getTime() - date.getTime()) / 1000

    if (
        session.disconnected_at ||
        secondsAgo(session.last_heartbeat_at) > DISCONNECTED_AFTER_SECONDS
    ) {
        return 'disconnected'
    }
    if (session.on_break) return 'break'
    // Sesi kamera saja (iPhone): layar dianggap terpenuhi, yang wajib hanya kamera.
    // Pemegang izin "Boleh menutup layar" (screen_optional) diperlakukan sama: layar bukan syarat bekerja.
    const screenOk =
        session.screen_active || session.camera_only === true || session.screen_optional === true
    // Kamera saja + kamera mati = tidak ada yang tersiar sama sekali.
    if (!session.camera_active && (session.camera_only === true || !session.screen_active)) {
        // Detik-detik pertama sesi kamera memang belum menyala.
        return secondsAgo(session.started_at) < ALERT_GRACE_SECONDS ? 'camera_off' : 'alert'
    }
    if (!session.camera_active) return 'camera_off'
    if (!screenOk) return 'screen_off'
    if (session.idle) return 'idle'
    return 'working'
}

/** Ambil hanya kolom status yang valid (boolean) dari laporan staf. */
export function parseReportedState(payload: unknown): Partial<Record<StateColumn, boolean>> {
    const state: Partial<Record<StateColumn, boolean>> = {}
    if (!payload || typeof payload !== 'object') return state

    for (const column of Object.keys(STATE_EVENTS) as StateColumn[]) {
        const value = (payload as Record<string, unknown>)[column]
        if (typeof value === 'boolean') state[column] = value
    }
    return state
}
