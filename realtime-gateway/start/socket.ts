import type { Server as SocketIoServer } from 'socket.io'
import { DateTime } from 'luxon'
import logger from '#services/log'
import Device from '#models/device'
import Organization from '#models/organization'
import ConsentDocument from '#models/consent_document'
import ApkBuild from '#models/apk_build'
import DeviceLocation from '#models/device_location'
import socketManager from '#services/socket_manager'
import { verifyBearerToken } from '#services/backend_api_client'
import { evaluateGeofence } from '#services/geofence_evaluator'
import { markCommandAcknowledged } from '#services/command_dispatcher'

type DeviceHelloPayload = {
  deviceUuid: string
  siteCode: string
  appBuildVersion?: string
  checksumSha256?: string
}

type DeviceLocationPayload = {
  source: 'ble' | 'gps' | 'ble_estimated'
  latitude?: number | null
  longitude?: number | null
  bleDistanceMeters?: number | null
  bleRssi?: number | null
  batteryLevel?: number | null
  ssid?: string | null
  ip?: string | null
}

const PIRACY_WARNING = 'silahkan download dari sumber resmi bosku'

/**
 * Mendaftarkan semua handler Socket.IO. Dipanggil sekali dari bin/server.ts
 * setelah instance Socket.IO dibuat dan dibungkus ke socketManager.
 */
export function registerSocketHandlers(io: SocketIoServer) {
  const deviceNs = io.of('/device')
  const opsNs = io.of('/ops')

  socketManager.setIo(io, deviceNs, opsNs)

  registerDeviceNamespace(deviceNs)
  registerOpsNamespace(opsNs)
}

function registerDeviceNamespace(deviceNs: ReturnType<SocketIoServer['of']>) {
  deviceNs.on('connection', (socket) => {
    let boundDeviceId: number | null = null
    let boundOrganizationId: number | null = null

    // Device wajib "hello" dalam 10 detik, kalau tidak diputus.
    const helloTimeout = setTimeout(() => {
      if (boundDeviceId === null) {
        socket.emit('device:rejected', { message: 'Timeout: tidak ada hello dalam 10 detik' })
        socket.disconnect(true)
      }
    }, 10_000)

    socket.on('device:hello', async (payload: DeviceHelloPayload) => {
      try {
        const device = await Device.query()
          .where('device_uuid', payload.deviceUuid)
          .where('is_active', true)
          .first()

        if (!device) {
          socket.emit('device:rejected', { message: 'Device tidak dikenali atau dinonaktifkan' })
          return socket.disconnect(true)
        }

        const organization = await Organization.find(device.organizationId)
        if (!organization || !organization.isActive) {
          socket.emit('device:rejected', { message: 'Site tidak aktif' })
          return socket.disconnect(true)
        }

        // Kode site yang ditanam di APK harus cocok dengan site aslinya.
        // Mismatch -> kemungkinan APK hasil tempel/clone dari site lain.
        if (payload.siteCode !== organization.uniqueSiteCode) {
          socket.emit('device:rejected', { message: PIRACY_WARNING })
          return socket.disconnect(true)
        }

        // Kalau versi APK + checksum dikirim, cocokkan ke registry apk_builds
        // (lihat permintaan awal: 2 kode unik sama tapi checksum beda -> tolak).
        if (payload.appBuildVersion && payload.checksumSha256) {
          const registered = await ApkBuild.query()
            .where('organization_id', device.organizationId)
            .where('version', payload.appBuildVersion)
            .first()

          if (registered && registered.checksumSha256 !== payload.checksumSha256) {
            socket.emit('device:rejected', { message: PIRACY_WARNING })
            return socket.disconnect(true)
          }
        }

        const consent = await ConsentDocument.find(device.consentDocumentId)
        if (!consent || !consent.isActive()) {
          socket.emit('device:rejected', {
            message: 'Dokumen consent sudah tidak berlaku, hubungi admin',
          })
          return socket.disconnect(true)
        }

        clearTimeout(helloTimeout)
        boundDeviceId = device.id
        boundOrganizationId = device.organizationId

        socket.join(`device:${device.id}`)
        socket.join(`org:${device.organizationId}`)

        device.status = device.status === 'locked' ? 'locked' : 'online'
        device.lastSeenAt = DateTime.now()
        await device.save()

        socket.emit('device:accepted', { deviceId: device.id, status: device.status })

        socketManager.broadcastDeviceStatus(device.organizationId, {
          device_id: device.id,
          device_name: device.deviceName,
          status: device.status,
        })

        logger.info('device terhubung', { deviceId: device.id })
      } catch (error) {
        logger.error('device:hello gagal diproses', { error })
        socket.emit('device:rejected', { message: 'Terjadi kesalahan server' })
        socket.disconnect(true)
      }
    })

    socket.on('device:location', async (payload: DeviceLocationPayload) => {
      if (boundDeviceId === null) return

      try {
        await DeviceLocation.create({
          deviceId: boundDeviceId,
          source: payload.source,
          latitude: payload.latitude ?? null,
          longitude: payload.longitude ?? null,
          bleDistanceMeters: payload.bleDistanceMeters ?? null,
          bleRssi: payload.bleRssi ?? null,
          recordedAt: DateTime.now(),
          createdAt: DateTime.now(),
        })

        const device = await Device.find(boundDeviceId)
        if (!device) return

        device.lastSeenAt = DateTime.now()
        if (payload.batteryLevel !== undefined && payload.batteryLevel !== null) {
          device.batteryLevel = payload.batteryLevel
        }
        await device.save()

        socketManager.broadcastRadarUpdate(device.organizationId, {
          device_id: device.id,
          device_name: device.deviceName,
          status: device.status,
          source: payload.source,
          latitude: payload.latitude ?? null,
          longitude: payload.longitude ?? null,
          ble_distance_meters: payload.bleDistanceMeters ?? null,
          battery_level: device.batteryLevel,
          recorded_at: DateTime.now().toISO(),
        })

        await evaluateGeofence(device, {
          ssid: payload.ssid,
          ip: payload.ip,
          bleDistanceMeters: payload.bleDistanceMeters,
        })
      } catch (error) {
        logger.error('device:location gagal diproses', { error })
      }
    })

    socket.on('command:ack', async (payload: { commandId: number }) => {
      if (boundDeviceId === null) return
      await markCommandAcknowledged(payload.commandId)
    })

    socket.on('disconnect', async () => {
      clearTimeout(helloTimeout)
      if (boundDeviceId === null || boundOrganizationId === null) return

      try {
        const device = await Device.find(boundDeviceId)
        if (!device) return

        // Device yang sedang 'locked' tetap tercatat locked walau socket putus
        // (jangan diam-diam jadi 'offline' seolah tidak terkunci lagi).
        if (device.status !== 'locked') {
          device.status = 'offline'
          await device.save()
        }

        socketManager.broadcastDeviceStatus(boundOrganizationId, {
          device_id: device.id,
          device_name: device.deviceName,
          status: device.status,
        })
      } catch (error) {
        logger.error('gagal menandai device offline saat disconnect', { error })
      }
    })
  })
}

function registerOpsNamespace(opsNs: ReturnType<SocketIoServer['of']>) {
  // Dashboard web & APK master wajib login (Bearer token Sanctum dari
  // backend-api Laravel) sebelum bisa berlangganan radar/alert — tidak ada
  // jalur pintas di sini.
  opsNs.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined

    if (!token) {
      return next(new Error('Token tidak ditemukan'))
    }

    const user = await verifyBearerToken(token)
    if (!user) {
      return next(new Error('Token tidak valid atau kedaluwarsa'))
    }

    socket.data.user = user
    next()
  })

  opsNs.on('connection', (socket) => {
    const user = socket.data.user as Awaited<ReturnType<typeof verifyBearerToken>>
    if (!user) return socket.disconnect(true)

    const isSuperAdmin = user.roles.includes('super_admin')

    socket.on('subscribe:organization', (organizationId: number) => {
      if (!isSuperAdmin && organizationId !== user.organizationId) {
        socket.emit('subscribe:rejected', { organizationId, message: 'Bukan site Anda' })
        return
      }
      socket.join(`org:${organizationId}`)
      socket.emit('subscribe:confirmed', { organizationId })
    })

    // Bukan super_admin otomatis berlangganan site miliknya sendiri.
    if (!isSuperAdmin && user.organizationId) {
      socket.join(`org:${user.organizationId}`)
    }

    logger.info('ops client terhubung', { userId: user.id, username: user.username })
  })
}
