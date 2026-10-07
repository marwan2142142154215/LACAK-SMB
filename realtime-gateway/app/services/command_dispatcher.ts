import { DateTime } from 'luxon'
import DeviceCommand from '#models/device_command'
import socketManager from '#services/socket_manager'
import logger from '#services/log'

/**
 * Satu-satunya jalur pengiriman perintah ke device: poll baris
 * device_commands berstatus 'pending' secara berkala, kirim ke device yang
 * sedang terkoneksi socket (room `device:{id}`), lalu tandai 'delivered'.
 * Device sendiri yang mengirim balik 'command:ack' untuk menandai
 * 'acknowledged' (lihat start/socket.ts).
 *
 * Kenapa polling, bukan push langsung dari DeviceCommandController Laravel:
 * supaya Laravel (PHP) dan gateway (Node) tetap longgar-terhubung lewat satu
 * sumber kebenaran (tabel device_commands), bukan saling panggil HTTP
 * sinkron yang gampang gagal kalau salah satu proses sedang restart.
 */
export function startCommandDispatcher(intervalMs: number) {
  const timer = setInterval(async () => {
    try {
      await dispatchPendingCommands()
    } catch (error) {
      logger.error('command_dispatcher: gagal memproses antrean perintah', { error })
    }
  }, intervalMs)

  return () => clearInterval(timer)
}

async function dispatchPendingCommands() {
  const pending = await DeviceCommand.query().where('status', 'pending').orderBy('id').limit(100)

  for (const command of pending) {
    const room = socketManager.devices.adapter.rooms.get(`device:${command.deviceId}`)
    const isDeviceConnected = !!room && room.size > 0

    if (!isDeviceConnected) continue // tetap 'pending', dicoba lagi tick berikutnya

    socketManager.devices.to(`device:${command.deviceId}`).emit('command:push', {
      command_id: command.id,
      command_type: command.commandType,
      reason_note: command.reasonNote,
    })

    command.status = 'delivered'
    await command.save()
  }
}

export async function markCommandAcknowledged(commandId: number) {
  const command = await DeviceCommand.find(commandId)
  if (!command) return

  command.status = 'acknowledged'
  command.acknowledgedAt = DateTime.now()
  await command.save()
}
