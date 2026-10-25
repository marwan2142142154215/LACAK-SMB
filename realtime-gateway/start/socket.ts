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
import { extendSession, isSessionStillValid, verifyBearerToken } from '#services/backend_api_client'
import { registerLiveHandlers, startLiveSweeper } from '#services/live_hub'
import { evaluateGeofence } from '#services/geofence_evaluator'
import { markCommandAcknowledged } from '#services/command_dispatcher'
import { beaconUuidFor, isDeviceSecretValid } from '#services/device_credentials'
import {
    registerMasterBeacon,
    unregisterMasterBeaconsForSocket,
} from '#services/master_anchor_registry'
import { chatRoom, fetchChatHistory, fetchChatMessage, postChatMessage } from '#services/chat_relay'

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
    // APK Lacak scan BLE tanpa filter, jadi bisa melihat APK Master yang
    // kebetulan di dekatnya: UUID + jarak sinyal BLE terdekat selain anchor
    // tetap, dicocokkan ke master_anchor_registry oleh geofence_evaluator.
    nearbyBeaconUuid?: string | null
    nearbyBeaconDistanceMeters?: number | null
}

const PIRACY_WARNING = 'silahkan download dari sumber resmi bosku'

// Kode dikirim di error.data supaya APK bisa membedakan "rahasia salah/hilang,
// klaim ulang" dari gangguan server sementara tanpa mengurai teks pesan.
type DeviceAuthErrorCode =
    'invalid_credentials' | 'reenroll_required' | 'rate_limited' | 'server_error'

const INVALID_CREDENTIALS_MESSAGE =
    'Kredensial device tidak valid, minta admin mendaftarkan ulang device ini'
const RATE_LIMITED_MESSAGE = 'Terlalu banyak percobaan, coba lagi nanti'
const REENROLL_REQUIRED_MESSAGE =
    'Device ini terdaftar sebelum pembaruan keamanan dan wajib didaftarkan ulang oleh admin'

function deviceAuthError(message: string, code: DeviceAuthErrorCode) {
    const error = new Error(message) as Error & { data?: { code: DeviceAuthErrorCode } }
    error.data = { code }
    return error
}

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
    startLiveSweeper(opsNs)
}

// Pembatas percobaan handshake device per alamat IP: tiap percobaan (termasuk
// deviceUuid acak) memicu query Postgres sebelum ditolak, jadi tanpa batas
// satu klien bisa membebani DB. In-memory cukup untuk satu instance gateway.
const HANDSHAKE_WINDOW_MS = 60_000
const HANDSHAKE_MAX_ATTEMPTS = 20
const handshakeAttemptsByIp = new Map<string, { count: number; windowStart: number }>()

function isHandshakeRateLimited(ip: string): boolean {
    const now = Date.now()
    const entry = handshakeAttemptsByIp.get(ip)

    if (!entry || now - entry.windowStart > HANDSHAKE_WINDOW_MS) {
        handshakeAttemptsByIp.set(ip, { count: 1, windowStart: now })
        return false
    }

    entry.count += 1
    return entry.count > HANDSHAKE_MAX_ATTEMPTS
}

function registerDeviceNamespace(deviceNs: ReturnType<SocketIoServer['of']>) {
    // device_uuid & site code tidak rahasia (tampil di layar / tertanam di APK),
    // jadi identitas device hanya diterima kalau handshake juga membawa rahasia
    // device yang hash-nya cocok dengan devices.secret_hash. Tanpa ini siapa pun
    // yang tahu device_uuid bisa menyamar: mengirim lokasi palsu (memicu
    // auto-unlock geofence) dan menerima command:push milik device itu.
    deviceNs.use(async (socket, next) => {
        if (isHandshakeRateLimited(socket.handshake.address)) {
            return next(deviceAuthError(RATE_LIMITED_MESSAGE, 'rate_limited'))
        }

        const deviceUuid = socket.handshake.auth?.deviceUuid
        const deviceSecret = socket.handshake.auth?.deviceSecret

        if (typeof deviceUuid !== 'string' || deviceUuid === '') {
            return next(deviceAuthError(INVALID_CREDENTIALS_MESSAGE, 'invalid_credentials'))
        }
        if (typeof deviceSecret !== 'string' || deviceSecret === '') {
            return next(deviceAuthError(INVALID_CREDENTIALS_MESSAGE, 'invalid_credentials'))
        }

        try {
            const device = await Device.query()
                .where('device_uuid', deviceUuid)
                .whereNull('deleted_at')
                .first()

            if (!device) {
                return next(deviceAuthError(INVALID_CREDENTIALS_MESSAGE, 'invalid_credentials'))
            }

            if (!device.secretHash) {
                logger.warn('device tanpa secret_hash ditolak, perlu daftar ulang', {
                    deviceId: device.id,
                })
                return next(deviceAuthError(REENROLL_REQUIRED_MESSAGE, 'reenroll_required'))
            }

            if (!isDeviceSecretValid(deviceSecret, device.secretHash)) {
                logger.warn('rahasia device tidak cocok', { deviceId: device.id })
                return next(deviceAuthError(INVALID_CREDENTIALS_MESSAGE, 'invalid_credentials'))
            }

            socket.data.deviceId = device.id
            socket.data.deviceUuid = device.deviceUuid
            next()
        } catch (error) {
            logger.error('autentikasi device gagal diproses', { error })
            next(deviceAuthError('Terjadi kesalahan server', 'server_error'))
        }
    })

    deviceNs.on('connection', (socket) => {
        const authenticatedDeviceId = socket.data.deviceId as number
        const authenticatedDeviceUuid = socket.data.deviceUuid as string
        let boundDeviceId: number | null = null
        let boundOrganizationId: number | null = null

        // Device wajib "hello" dalam 10 detik, kalau tidak diputus.
        const helloTimeout = setTimeout(() => {
            if (boundDeviceId === null) {
                socket.emit('device:rejected', {
                    message: 'Timeout: tidak ada hello dalam 10 detik',
                })
                socket.disconnect(true)
            }
        }, 10_000)

        socket.on('device:hello', async (payload: DeviceHelloPayload) => {
            try {
                // hello hanya boleh untuk identitas yang sudah lolos autentikasi
                // handshake -- tanpa ini socket yang sah bisa "hello" sebagai device lain.
                if (payload?.deviceUuid !== authenticatedDeviceUuid) {
                    socket.emit('device:rejected', { message: INVALID_CREDENTIALS_MESSAGE })
                    return socket.disconnect(true)
                }

                const device = await Device.query()
                    .where('id', authenticatedDeviceId)
                    .where('is_active', true)
                    // Soft-delete Laravel (SoftDeletes trait) cuma menandai deleted_at --
                    // Lucid di sini tidak tahu konsep itu dan sebelumnya tetap menerima
                    // koneksi dari device yang sudah "dihapus" dari dashboard, karena
                    // is_active tidak otomatis ikut false saat soft-delete.
                    .whereNull('deleted_at')
                    .first()

                if (!device) {
                    socket.emit('device:rejected', {
                        message: 'Device tidak dikenali atau dinonaktifkan',
                    })
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
                    // Yang dikirim UUID beacon turunan, bukan device_uuid anchor --
                    // device_uuid adalah identitas login dan tidak boleh disebar ke
                    // seluruh device site.
                    bleAnchorUuid = anchorDevice ? beaconUuidFor(anchorDevice.deviceUuid) : null
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
                const deviceId = boundDeviceId

                // Titik lokasi dan last_seen_at/baterai device disimpan bersama supaya
                // riwayat lokasi tidak pernah maju tanpa status device ikut diperbarui.
                const device = await DeviceLocation.transaction(async (trx) => {
                    await DeviceLocation.create(
                        {
                            deviceId,
                            source: payload.source,
                            latitude: payload.latitude ?? null,
                            longitude: payload.longitude ?? null,
                            bleDistanceMeters: payload.bleDistanceMeters ?? null,
                            bleRssi: payload.bleRssi ?? null,
                            recordedAt: DateTime.now(),
                            createdAt: DateTime.now(),
                        },
                        { client: trx }
                    )

                    const reportingDevice = await Device.find(deviceId, { client: trx })
                    if (!reportingDevice) return null

                    reportingDevice.lastSeenAt = DateTime.now()
                    if (payload.batteryLevel !== undefined && payload.batteryLevel !== null) {
                        reportingDevice.batteryLevel = payload.batteryLevel
                    }
                    await reportingDevice.save()

                    return reportingDevice
                })
                if (!device) return

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
                    nearbyBeaconUuid: payload.nearbyBeaconUuid,
                    nearbyBeaconDistanceMeters: payload.nearbyBeaconDistanceMeters,
                })
            } catch (error) {
                logger.error('device:location gagal diproses', { error })
            }
        })

        socket.on('command:ack', async (payload: { commandId: number }) => {
            if (boundDeviceId === null) return

            // commandId berasal dari payload socket (tidak tepercaya): nilai
            // bukan angka membuat query Postgres reject, dan tanpa try/catch
            // unhandled rejection itu mematikan seluruh proses gateway.
            if (!Number.isInteger(payload?.commandId)) return

            try {
                await markCommandAcknowledged(payload.commandId, boundDeviceId)
            } catch (error) {
                logger.error('command:ack gagal diproses', { error, deviceId: boundDeviceId })
            }
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

        // Idle timeout (standar 6.4) ditegakkan backend-api lewat expires_at
        // token, tapi socket hanya memverifikasi token sekali saat connect.
        // Cek ulang berkala lewat /auth/session (tidak memperpanjang token),
        // supaya tab dashboard yang didiamkan tetap kena idle timeout. Gangguan
        // jaringan ke backend (null) tidak memutus sesi.
        // Staf yang sedang siaran: pakai /auth/me yang MEMPERPANJANG sesi --
        // heartbeat-nya lewat socket (live:state), bukan request HTTP.
        const token = socket.handshake.auth?.token as string
        const revalidate = setInterval(
            async () => {
                const check = socket.data.liveBroadcasting ? extendSession : isSessionStillValid
                if ((await check(token)) === false) {
                    socket.emit('session:expired', {
                        message: 'Sesi berakhir, silakan login ulang',
                    })
                    socket.disconnect(true)
                }
            },
            5 * 60 * 1000
        )

        // APK Master jadi "anchor bergerak": selama socket /ops ini hidup dan
        // APK Master memanggil master:beacon:start, APK Lacak yang mendeteksinya
        // lewat BLE dalam radius aman dianggap berada di tempat aman (lihat
        // master_anchor_registry.ts, yang juga memeriksa izin devices.unlock).
        socket.on('master:beacon:start', (payload: { beaconUuid?: string }) => {
            if (typeof payload?.beaconUuid !== 'string' || payload.beaconUuid === '') return
            registerMasterBeacon(payload.beaconUuid, user, socket.id)
        })

        socket.on('master:beacon:stop', () => {
            unregisterMasterBeaconsForSocket(socket.id)
        })

        registerChatHandlers(opsNs, socket, user, token)
        registerLiveHandlers(opsNs, socket, user)

        socket.on('disconnect', () => {
            clearInterval(revalidate)
            unregisterMasterBeaconsForSocket(socket.id)
        })

        logger.info('ops client terhubung', { userId: user.id, username: user.username })
    })
}

type OpsNamespace = ReturnType<SocketIoServer['of']>
type OpsSocket = Parameters<Parameters<OpsNamespace['on']>[1]>[0]
type ChatAck = (response: Record<string, unknown>) => void

/**
 * Floating chat staf per site (lihat app/services/chat_relay.ts). Izin masuk
 * ruang & penyimpanan pesan selalu lewat backend-api dengan token user ini;
 * gateway hanya menyiarkan ke socket lain di ruang yang sama.
 */
function registerChatHandlers(
    opsNs: OpsNamespace,
    socket: OpsSocket,
    user: NonNullable<Awaited<ReturnType<typeof verifyBearerToken>>>,
    token: string
) {
    const joinedRooms = new Set<number>()
    const ack = (callback: unknown): ChatAck =>
        typeof callback === 'function' ? (callback as ChatAck) : () => {}

    // Siapa saja yang sedang membuka chat site ini (unik per user, bukan per tab).
    async function broadcastPresence(organizationId: number) {
        const sockets = await opsNs.in(chatRoom(organizationId)).fetchSockets()
        const users = new Map<number, { id: number; name: string }>()
        for (const peer of sockets) {
            const peerUser = peer.data.user
            if (peerUser) users.set(peerUser.id, { id: peerUser.id, name: peerUser.name })
        }
        opsNs.to(chatRoom(organizationId)).emit('chat:presence', {
            organizationId,
            users: [...users.values()],
        })
    }

    socket.on('chat:join', async (payload: { organizationId?: number }, callback?: unknown) => {
        const organizationId = Number(payload?.organizationId)
        if (!Number.isInteger(organizationId) || organizationId <= 0) {
            return ack(callback)({ ok: false, message: 'Site tidak valid' })
        }

        const history = await fetchChatHistory(token, organizationId)
        if (!history.ok) return ack(callback)({ ok: false, message: history.message })

        socket.join(chatRoom(organizationId))
        joinedRooms.add(organizationId)
        ack(callback)({ ok: true, ...history.data })
        await broadcastPresence(organizationId)
    })

    socket.on('chat:leave', async (payload: { organizationId?: number }) => {
        const organizationId = Number(payload?.organizationId)
        if (!joinedRooms.delete(organizationId)) return
        socket.leave(chatRoom(organizationId))
        await broadcastPresence(organizationId)
    })

    socket.on(
        'chat:history',
        async (payload: { organizationId?: number; beforeId?: number }, callback?: unknown) => {
            const organizationId = Number(payload?.organizationId)
            if (!joinedRooms.has(organizationId)) {
                return ack(callback)({ ok: false, message: 'Buka ruang chat site ini dulu' })
            }
            const history = await fetchChatHistory(token, organizationId, Number(payload?.beforeId))
            ack(callback)(
                history.ok ? { ok: true, ...history.data } : { ok: false, message: history.message }
            )
        }
    )

    socket.on(
        'chat:send',
        async (
            payload: { organizationId?: number; body?: unknown; replyToId?: unknown },
            callback?: unknown
        ) => {
            const organizationId = Number(payload?.organizationId)
            if (!joinedRooms.has(organizationId)) {
                return ack(callback)({ ok: false, message: 'Buka ruang chat site ini dulu' })
            }
            if (typeof payload?.body !== 'string' || payload.body.trim() === '') {
                return ack(callback)({ ok: false, message: 'Pesan tidak boleh kosong' })
            }
            const replyToId = Number(payload?.replyToId)

            const result = await postChatMessage(
                token,
                organizationId,
                payload.body,
                Number.isInteger(replyToId) && replyToId > 0 ? replyToId : undefined
            )
            if (!result.ok) return ack(callback)({ ok: false, message: result.message })

            // Pengirim menerima pesan lewat ack; socket lain (termasuk tab lain
            // milik user yang sama) lewat siaran ruang.
            socket.to(chatRoom(organizationId)).emit('chat:message', result.data)
            ack(callback)({ ok: true, message: result.data })
        }
    )

    // Pesan bergambar sudah disimpan lewat unggahan langsung ke backend-api;
    // di sini hanya disiarkan ke peserta lain, setelah diambil ulang dari
    // backend (dengan token user ini) supaya isinya tidak bisa dipalsukan.
    socket.on(
        'chat:announce',
        async (payload: { organizationId?: number; messageId?: number }, callback?: unknown) => {
            const organizationId = Number(payload?.organizationId)
            const messageId = Number(payload?.messageId)
            if (
                !joinedRooms.has(organizationId) ||
                !Number.isInteger(messageId) ||
                messageId <= 0
            ) {
                return ack(callback)({ ok: false, message: 'Buka ruang chat site ini dulu' })
            }

            const result = await fetchChatMessage(token, messageId)
            if (!result.ok) return ack(callback)({ ok: false, message: result.message })
            // Hanya pesan milik user ini sendiri, di ruang yang dia buka.
            if (result.data.organization_id !== organizationId || result.data.user_id !== user.id) {
                return ack(callback)({ ok: false, message: 'Pesan tidak bisa disiarkan' })
            }

            socket.to(chatRoom(organizationId)).emit('chat:message', result.data)
            ack(callback)({ ok: true })
        }
    )

    socket.on('chat:typing', (payload: { organizationId?: number }) => {
        const organizationId = Number(payload?.organizationId)
        if (!joinedRooms.has(organizationId)) return
        socket.to(chatRoom(organizationId)).emit('chat:typing', {
            organizationId,
            user: { id: user.id, name: user.name },
        })
    })

    socket.on('disconnect', () => {
        for (const organizationId of joinedRooms) broadcastPresence(organizationId).catch(() => {})
    })
}
