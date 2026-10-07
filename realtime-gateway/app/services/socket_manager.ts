import type { Server as SocketIoServer, Namespace } from 'socket.io'

/**
 * Singleton sederhana untuk menyimpan instance Socket.IO supaya bisa dipakai
 * dari mana saja (command_dispatcher, controller HTTP internal, dsb) tanpa
 * harus lewat dependency injection container AdonisJS yang berat untuk kasus
 * ini. Diisi sekali oleh bin/server.ts saat HTTP server dibuat.
 */
class SocketManager {
  private ioInstance: SocketIoServer | null = null
  private deviceNamespace: Namespace | null = null
  private opsNamespace: Namespace | null = null

  setIo(io: SocketIoServer, deviceNs: Namespace, opsNs: Namespace) {
    this.ioInstance = io
    this.deviceNamespace = deviceNs
    this.opsNamespace = opsNs
  }

  get io() {
    if (!this.ioInstance) throw new Error('Socket.IO belum diinisialisasi')
    return this.ioInstance
  }

  get devices() {
    if (!this.deviceNamespace) throw new Error('Namespace /device belum diinisialisasi')
    return this.deviceNamespace
  }

  get ops() {
    if (!this.opsNamespace) throw new Error('Namespace /ops belum diinisialisasi')
    return this.opsNamespace
  }

  /** Broadcast update radar ke semua dashboard/master yang berlangganan satu organization. */
  broadcastRadarUpdate(organizationId: number, payload: unknown) {
    this.opsNamespace?.to(`org:${organizationId}`).emit('radar:update', payload)
  }

  broadcastViolation(organizationId: number, payload: unknown) {
    this.opsNamespace?.to(`org:${organizationId}`).emit('violation:alert', payload)
  }

  broadcastDeviceStatus(organizationId: number, payload: unknown) {
    this.opsNamespace?.to(`org:${organizationId}`).emit('device:status', payload)
  }
}

export default new SocketManager()
