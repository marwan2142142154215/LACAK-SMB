import type { Server as SocketIoServer } from 'socket.io'
import { DateTime } from 'luxon'
import logger from '#services/log'
import Device from '#models/device'
import Organization from '#models/organization'
import ConsentDocument from '#models/consent_document'
import ApkBuild from '#models/apk_build'
import DeviceLocation from '#models/device_location'
import GeofenceRule from '#models/geofence_rule'
import socketManager from '#services/socket_manager'
import { verifyBearerToken } from '#services/backend_api_client'
import { evaluateGeofence } from '#services/geofence_evaluator'
import { markCommandAcknowledged } from '#services/command_dispatcher'

type DeviceHelloPayload = {
  deviceUuid: string
  siteCode: string
  appBuildVersion?: string
  checksumSha256?: string
  deviceSecret?: string
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
          // Soft-delete Laravel (SoftDeletes trait) cuma menandai deleted_at --
          // Lucid di sini tidak tahu konsep itu dan sebelumnya tetap menerima
          // koneksi dari device yang sudah "dihapus" dari dashboard, karena
          // is_active tidak otomatis ikut false saat soft-delete.
          .whereNull('deleted_at')
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

        // Vuln 5 (security review): deviceUuid+siteCode TIDAK rahasia --
        // deviceUuid disiarkan lewat BLE terus-menerus, siteCode tertanam di
        // setiap APK site itu. Siapa pun yang tahu dua nilai itu sebelumnya
        // bisa menyamar sebagai device asli (device:hello palsu). device_secret
        // didapat device lewat pairing sekali (lihat DeviceOtpController::pair,
        // diketik admin langsung ke device fisik dari kode OTP 6-digit) dan
        // TIDAK PERNAH ikut di APK maupun disiarkan. Kalau device ini SUDAH
        // pernah dipasangkan (device.deviceSecret terisi), secret WAJIB
        // cocok. Device yang belum pernah dipasangkan (device_secret masih
        // null -- APK lama sebelum fitur ini) tetap diterima seperti biasa
        // supaya device yang sedang aktif tidak mendadak terputus; begitu
        // dipasangkan ulang sekali, mode lama ini tidak berlaku lagi untuknya.
        if (device.deviceSecret && payload.deviceSecret !== device.deviceSecret) {
          logger.warn('device:hello ditolak -- device_secret tidak cocok (kemungkinan percobaan penyamaran)', {
            deviceId: device.id,
          })
          socket.emit('device:rejected', { message: 'Identitas device tidak valid, pasangkan ulang lewat admin' })
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

        // Mode BLE geofence: kalau site ini punya aturan dengan anchor_device_id
        // (device referensi diam di lokasi), device yang baru connect ini
        // (selama dia BUKAN si anchor itu sendiri) diberi tahu UUID device
        // anchor yang harus di-scan terus-menerus -- APK Lacak lalu membaca
        // RSSI sinyal BLE anchor itu dan melaporkannya tiap heartbeat
        // (ble_distance_meters), dipakai evaluateGeofence untuk lock/unlock
        // otomatis presisi jarak dekat (bukan GPS yang bisa meleset puluhan
        // meter di dalam ruangan).
        const bleRule = await GeofenceRule.query()
          .where('organization_id', device.organizationId)
          .where('is_active', true)
          .whereNotNull('anchor_device_id')
          .whereNot('anchor_device_id', device.id)
          .first()

        let bleAnchorUuid: string | null = null
        let bleMaxDistanceMeters: number | null = null
        if (bleRule?.anchorDeviceId && bleRule?.maxDistanceMeters) {
          const anchorDevice = await Device.find(bleRule.anchorDeviceId)
          bleAnchorUuid = anchorDevice?.deviceUuid ?? null
          // Radius dikirim ke device supaya APK bisa MENGDETEKSI PERGANTIAN
          // status (keluar/masuk radius) SECEPATNYA di sisi phone, di dalam
          // callback scan BLE -- tanpa ini evaluasi geofence hanya jalan tiap
          // heartbeat (30 detik) dan auto-lock/unlock selalu terlambat satu
          // sampai dua periode. Nilai yang sama dipakai evaluateGeofence di
          // server; device TIDAK mengunci sendiri, cuma melapor lebih cepat.
          bleMaxDistanceMeters = bleRule.maxDistanceMeters
        }

        socket.emit('device:accepted', {
          deviceId: device.id,
          status: device.status,
          bleAnchorUuid,
          bleMaxDistanceMeters,
        })

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
          latitude: payload.latitude,
          longitude: payload.longitude,
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
        // Kalau device sudah punya socket LAIN yang masih terikat (reconnect
        // cepat: koneksi baru sudah hello duluan sementara koneksi lama yang
        // setengah mati baru sempat putus), JANGAN tandai offline -- device
        // sebenarnya masih terhubung. Catatan: socket.io sudah melepas semua
        // room sebelum event 'disconnect' ini dipancarkan, jadi ukuran room
        // di sini = jumlah socket HIDUP milik device ini selain yang ini.
        const livePeers = deviceNs.adapter.rooms.get(`device:${boundDeviceId}`)?.size ?? 0
        if (livePeers > 0) {
          logger.info('device masih punya koneksi lain, tidak ditandai offline', {
            deviceId: boundDeviceId,
          })
          return
        }

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

    // super_admin lintas site — tidak terikat satu organizationId, jadi
    // di-join ke room khusus yang ikut menerima semua broadcast org
    // (lihat socket_manager.ts broadcastRadarUpdate/broadcastViolation/
    // broadcastDeviceStatus). Tanpa ini radar super_admin cuma dapat
    // snapshot awal lewat REST lalu tidak pernah live-update lagi.
    if (isSuperAdmin) {
      socket.join('superadmins')
    }

    logger.info('ops client terhubung', { userId: user.id, username: user.username })
  })
}
