import { DateTime } from 'luxon'
// SENGAJA tanpa '@adonisjs/lucid/services/db': modul ini diimpor bin/server.ts SEBELUM app selesai
// boot, dan service db menunggu app.booted() saat diimpor -> gateway gagal start. Pakai model saja.
import Device from '#models/Device'
import DeviceCommand from '#models/DeviceCommand'
import socketManager from '#services/SocketManager'
import logger from '#services/Log'
import {
    planDispatch,
    transitionFromReport,
    type CommandReport,
    type CommandStatus,
    type OpenCommand,
} from '#services/CommandLifecycle'

/**
 * Satu-satunya jalur pengiriman perintah ke device: poll baris device_commands yang masih terbuka
 * (pending/delivered) secara berkala, kirim ke device yang sedang terkoneksi socket (room
 * `device:{id}`), lalu tandai 'delivered'. Device mengonfirmasi lewat 'command:ack' -- 'acknowledged'
 * saat diterima, lalu 'executed'/'failed' setelah dijalankan (lihat start/socket.ts).
 *
 * Perintah 'delivered' yang belum dikonfirmasi dikirim ULANG (socket HP bisa setengah mati saat
 * Doze/sinyal hilang), perintah lock/unlock lama digantikan yang terbaru, dan locate_now yang basi
 * dibatalkan -- aturan lengkapnya di CommandLifecycle.planDispatch. Setiap perubahan status
 * disiarkan ke dashboard ('device:command') supaya admin melihat apakah kunci benar-benar sampai.
 *
 * Kenapa polling, bukan push langsung dari backend: supaya backend dan gateway tetap longgar-terhubung
 * lewat satu sumber kebenaran (tabel device_commands), bukan saling panggil HTTP sinkron yang gampang
 * gagal kalau salah satu proses sedang restart.
 */
export function startCommandDispatcher(intervalMs: number) {
    const timer = setInterval(() => {
        dispatchPendingCommands().catch((error) => {
            logger.error('command_dispatcher: gagal memproses antrean perintah', { error })
        })
    }, intervalMs)

    return () => clearInterval(timer)
}

// Satu putaran dispatch dalam satu waktu: tick interval dan pemicu dari device:hello tidak boleh
// berjalan bersamaan (perintah yang sama bisa terkirim dua kali dan hitungan percobaan ganda).
let running: Promise<void> = Promise.resolve()

/**
 * Proses antrean sekarang. deviceId diisi saat device baru saja terhubung (device:hello) supaya
 * perintah yang menunggu -- mis. lock untuk HP yang baru dinyalakan ulang -- langsung terkirim
 * tanpa menunggu tick berikutnya.
 */
export function dispatchPendingCommands(deviceId?: number): Promise<void> {
    running = running.then(
        () => runDispatch(deviceId),
        () => runDispatch(deviceId)
    )
    return running
}

function isDeviceConnected(deviceId: number): boolean {
    const room = socketManager.devices.adapter.rooms.get(`device:${deviceId}`)
    return !!room && room.size > 0
}

async function runDispatch(deviceId?: number) {
    const query = DeviceCommand.query()
        .whereIn('status', ['pending', 'delivered'])
        .orderBy('id')
        .limit(200)
    if (deviceId !== undefined) query.where('device_id', deviceId)
    const open = await query
    if (!open.length) return

    const byId = new Map(open.map((command) => [command.id, command]))
    const plan = planDispatch(
        open.map((command): OpenCommand => ({
            id: command.id,
            deviceId: command.deviceId,
            commandType: command.commandType,
            status: command.status as OpenCommand['status'],
            createdAt: command.createdAt.toMillis(),
            deliveredAt: command.deliveredAt?.toMillis() ?? null,
            deliveryAttempts: command.deliveryAttempts ?? 0,
        })),
        Date.now(),
        isDeviceConnected
    )

    // Site tiap device diambil sekali untuk semua perintah di putaran ini (siaran status butuh
    // organization_id), bukan satu query per perubahan status.
    const hasWork = plan.expire.length + plan.fail.length + plan.send.length > 0
    const organizationOf = hasWork
        ? await organizationsOfDevices([...new Set(open.map((command) => command.deviceId))])
        : new Map<number, number>()

    for (const { id, message } of plan.expire) {
        await closeCommand(byId.get(id)!, 'expired', message, organizationOf)
    }
    for (const { id, message } of plan.fail) {
        await closeCommand(byId.get(id)!, 'failed', message, organizationOf)
    }

    for (const id of plan.send) {
        const command = byId.get(id)!
        // Status ditulis SEBELUM dipancarkan: HP bisa mengonfirmasi dalam hitungan milidetik, dan
        // konfirmasi untuk perintah yang di DB masih 'pending' akan ditolak (lihat transitionFromReport).
        const updated = await DeviceCommand.query()
            .where('id', command.id)
            .whereIn('status', ['pending', 'delivered'])
            .update({
                status: 'delivered',
                delivered_at: DateTime.now().toSQL({ includeOffset: false }),
                // Dispatch berjalan berurutan dalam satu proses (lihat `running`), jadi nilai yang
                // baru dibaca aman dipakai untuk menaikkan hitungan.
                delivery_attempts: (command.deliveryAttempts ?? 0) + 1,
                updated_at: DateTime.now().toSQL({ includeOffset: false }),
            })
        if (!affectedRows(updated)) continue

        socketManager.devices.to(`device:${command.deviceId}`).emit('command:push', {
            command_id: command.id,
            command_type: command.commandType,
            reason_note: command.reasonNote,
        })

        if (command.status === 'pending') {
            await broadcastCommandStatus(command, 'delivered', null, organizationOf)
        } else {
            logger.info('perintah dikirim ulang, belum dikonfirmasi HP', {
                commandId: command.id,
                deviceId: command.deviceId,
                attempt: (command.deliveryAttempts ?? 0) + 1,
            })
        }
    }
}

function affectedRows(result: unknown): number {
    if (Array.isArray(result)) return Number(result[0] ?? 0)
    return Number(result ?? 0)
}

async function organizationsOfDevices(deviceIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>()
    if (!deviceIds.length) return result
    const devices = await Device.query().whereIn('id', deviceIds).select('id', 'organization_id')
    for (const device of devices) result.set(device.id, Number(device.organizationId))
    return result
}

async function closeCommand(
    command: DeviceCommand,
    status: 'expired' | 'failed',
    message: string,
    organizationOf?: Map<number, number>
) {
    const updated = await DeviceCommand.query()
        .where('id', command.id)
        .whereIn('status', ['pending', 'delivered'])
        .update({
            status,
            result_message: message,
            updated_at: DateTime.now().toSQL({ includeOffset: false }),
        })
    if (!affectedRows(updated)) return
    command.status = status
    command.resultMessage = message
    logger.warn('perintah device ditutup tanpa dijalankan', {
        commandId: command.id,
        deviceId: command.deviceId,
        status,
        message,
    })
    await broadcastCommandStatus(command, status, message, organizationOf)
}

async function broadcastCommandStatus(
    command: DeviceCommand,
    status: CommandStatus,
    message: string | null,
    organizationOf?: Map<number, number>
) {
    let organizationId = organizationOf?.get(command.deviceId)
    if (organizationId === undefined) {
        const device = await Device.query()
            .where('id', command.deviceId)
            .select('id', 'organization_id')
            .first()
        if (!device) return
        organizationId = Number(device.organizationId)
    }
    socketManager.broadcastCommandStatus(organizationId, {
        device_id: command.deviceId,
        command_id: command.id,
        command_type: command.commandType,
        status,
        result_message: message,
        at: DateTime.now().toISO(),
    })
}

/**
 * Laporan HP untuk satu perintah. Hanya device pemilik perintah yang boleh melapor, dan hanya
 * perintah yang sudah benar-benar dikirim (lihat transitionFromReport). Tanpa ini device mana pun
 * bisa meng-ack ID perintah berurutan milik device lain -- perintah 'pending' yang di-ack duluan
 * tidak akan pernah dikirim, jadi lock-nya batal diam-diam.
 */
export async function recordCommandReport(
    commandId: number,
    deviceId: number,
    report: CommandReport = {}
) {
    const command = await DeviceCommand.query()
        .where('id', commandId)
        .where('device_id', deviceId)
        .first()
    if (!command) return

    const transition = transitionFromReport(command.status, report)
    if (!transition) return

    const now = DateTime.now()
    const sqlNow = now.toSQL({ includeOffset: false })
    const values: Record<string, unknown> = { status: transition.status, updated_at: sqlNow }
    if (transition.status === 'acknowledged') {
        values.acknowledged_at = sqlNow
    } else {
        // HP bisa langsung melapor hasil tanpa 'received' lebih dulu -- berarti juga sudah diterima.
        values.acknowledged_at = (command.acknowledgedAt ?? now).toSQL({ includeOffset: false })
        values.executed_at = sqlNow
        values.result_message = transition.message
    }
    // Bersyarat pada status yang tadi dibaca: dua laporan HP yang datang berdekatan ('received' lalu
    // 'executed') ditangani bersamaan, dan yang kalah cepat tidak boleh menimpa status yang lebih maju.
    const updated = await DeviceCommand.query()
        .where('id', command.id)
        .where('status', command.status)
        .update(values)
    if (!affectedRows(updated)) return

    command.status = transition.status
    await broadcastCommandStatus(command, transition.status, transition.message)
}

/** Nama lama, dipertahankan untuk APK lama yang hanya mengirim {commandId}. */
export async function markCommandAcknowledged(commandId: number, deviceId: number) {
    await recordCommandReport(commandId, deviceId, {})
}
