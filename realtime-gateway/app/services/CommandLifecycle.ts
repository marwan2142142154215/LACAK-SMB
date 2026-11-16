/**
 * Aturan siklus hidup perintah device (murni, tanpa DB) -- dipakai CommandDispatcher dan handler
 * `command:ack`, dan diuji di tests/unit/command_lifecycle.spec.ts.
 *
 *   pending ──kirim──▶ delivered ──HP terima──▶ acknowledged ──HP jalankan──▶ executed
 *      │                  │  ▲ kirim ulang tiap REDELIVER_AFTER_MS selama HP online   └──▶ failed
 *      │                  └──┘ (sampai MAX_DELIVERY_ATTEMPTS, lalu failed)
 *      └──▶ expired (kedaluwarsa / digantikan perintah lock-unlock yang lebih baru)
 *
 * 'delivered' hanya berarti "sudah dipancarkan ke socket HP" -- socket bisa setengah mati (HP
 * masuk Doze, sinyal hilang) sehingga perintah tidak pernah sampai. Karena itu perintah yang
 * belum dikonfirmasi HP dikirim ulang; APK mengabaikan command_id yang sudah pernah dijalankan.
 */

import { cleanText } from '#services/DeviceTelemetry'

export type CommandType = 'lock' | 'unlock' | 'start_monitor' | 'stop_monitor' | 'locate_now'
export type CommandStatus =
    'pending' | 'delivered' | 'acknowledged' | 'executed' | 'failed' | 'expired'

/** Kirim ulang perintah 'delivered' yang belum dikonfirmasi HP setelah jeda ini. */
export const REDELIVER_AFTER_MS = 20_000
/** Setelah sekian kali dikirim (HP online) tanpa konfirmasi, perintah dianggap gagal. */
export const MAX_DELIVERY_ATTEMPTS = 8
/** locate_now yang belum sampai setelah ini tidak berguna lagi (posisi "sekarang" sudah basi). */
export const LOCATE_EXPIRY_MS = 10 * 60 * 1000
/** start_monitor/stop_monitor kedaluwarsa setelah sehari tidak tersampaikan. */
export const MONITOR_EXPIRY_MS = 24 * 60 * 60 * 1000

export type OpenCommand = {
    id: number
    deviceId: number
    commandType: CommandType
    status: 'pending' | 'delivered'
    createdAt: number
    deliveredAt: number | null
    deliveryAttempts: number
}

export type DispatchPlan = {
    send: number[]
    expire: { id: number; message: string }[]
    fail: { id: number; message: string }[]
}

const LOCK_FAMILY = new Set<CommandType>(['lock', 'unlock'])

/**
 * Tentukan nasib tiap perintah terbuka (pending/delivered). Lock & unlock TIDAK pernah kedaluwarsa
 * karena umur -- HP yang baru menyala ulang seminggu kemudian tetap harus menerima kunci terakhir --
 * tapi hanya perintah lock/unlock TERBARU per device yang dikirim; yang lebih lama digantikan.
 */
export function planDispatch(
    commands: OpenCommand[],
    now: number,
    isConnected: (deviceId: number) => boolean
): DispatchPlan {
    const plan: DispatchPlan = { send: [], expire: [], fail: [] }

    // Perintah terbaru per device per keluarga (lock/unlock satu keluarga; jenis lain per jenis).
    const newest = new Map<string, number>()
    const familyKey = (command: OpenCommand) =>
        `${command.deviceId}:${LOCK_FAMILY.has(command.commandType) ? 'lock-family' : command.commandType}`
    for (const command of commands) {
        const key = familyKey(command)
        newest.set(key, Math.max(newest.get(key) ?? 0, command.id))
    }

    for (const command of [...commands].sort((a, b) => a.id - b.id)) {
        if (newest.get(familyKey(command)) !== command.id) {
            plan.expire.push({
                id: command.id,
                message: LOCK_FAMILY.has(command.commandType)
                    ? 'Digantikan perintah kunci/buka yang lebih baru'
                    : 'Digantikan perintah yang sama yang lebih baru',
            })
            continue
        }

        const age = now - command.createdAt
        if (command.commandType === 'locate_now' && age > LOCATE_EXPIRY_MS) {
            plan.expire.push({
                id: command.id,
                message: 'HP tidak terhubung dalam 10 menit, permintaan lokasi dibatalkan',
            })
            continue
        }
        if (
            (command.commandType === 'start_monitor' || command.commandType === 'stop_monitor') &&
            age > MONITOR_EXPIRY_MS
        ) {
            plan.expire.push({ id: command.id, message: 'HP tidak terhubung dalam 24 jam' })
            continue
        }

        if (!isConnected(command.deviceId)) continue

        if (command.status === 'pending') {
            plan.send.push(command.id)
            continue
        }

        // delivered tapi belum dikonfirmasi HP.
        const sinceDelivery = now - (command.deliveredAt ?? 0)
        if (sinceDelivery < REDELIVER_AFTER_MS) continue
        if (command.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
            plan.fail.push({
                id: command.id,
                message: `HP tidak mengonfirmasi setelah ${command.deliveryAttempts} kali dikirim`,
            })
            continue
        }
        plan.send.push(command.id)
    }

    return plan
}

/** Laporan dari HP lewat `command:ack`. Tanpa `result` = APK lama yang hanya mengonfirmasi terima. */
export type CommandReport = { result?: unknown; message?: unknown }

export type CommandTransition = {
    status: 'acknowledged' | 'executed' | 'failed'
    message: string | null
}

/**
 * Status berikutnya dari laporan HP, atau null kalau laporan tidak berlaku untuk status sekarang
 * (mis. perintah 'pending' yang belum pernah dikirim, atau sudah selesai). Hanya maju, tidak mundur.
 */
export function transitionFromReport(
    current: CommandStatus,
    report: CommandReport
): CommandTransition | null {
    const result = typeof report.result === 'string' ? report.result : 'received'
    // Pesan dari HP disimpan & disiarkan ke dashboard: karakter kontrol (baris baru, ANSI) dibuang.
    const message = cleanText(report.message, 255)

    if (result === 'received') {
        return current === 'delivered' ? { status: 'acknowledged', message: null } : null
    }
    if (result === 'executed' || result === 'failed') {
        return current === 'delivered' || current === 'acknowledged'
            ? { status: result, message }
            : null
    }
    return null
}

/** Label Bahasa Indonesia untuk notifikasi/log. */
export const COMMAND_STATUS_LABELS: Record<CommandStatus, string> = {
    pending: 'Menunggu HP online',
    delivered: 'Terkirim',
    acknowledged: 'Diterima HP',
    executed: 'Dijalankan',
    failed: 'Gagal',
    expired: 'Kedaluwarsa',
}
