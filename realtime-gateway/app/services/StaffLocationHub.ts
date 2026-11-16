import type { Server as SocketIoServer } from 'socket.io'
import { DateTime } from 'luxon'
import logger from '#services/Log'
import StaffLocation from '#models/StaffLocation'
import socketManager from '#services/SocketManager'
import type { AuthenticatedUser } from '#services/BackendApiClient'
import { cleanCoordinate, cleanNumber } from '#services/DeviceTelemetry'

/**
 * Lokasi staf lewat socket /ops, event `staff:location`. Dikirim agen native
 * (APK di HP, aplikasi desktop di PC; browser tidak dipakai sebagai pelacak).
 * Hanya user pemegang izin `location.share`. Koordinat divalidasi, disimpan ke
 * `staff_locations`, lalu disiarkan ke ruang radar site-nya supaya pengawas
 * (radar.view) melihatnya di peta. Payload socket = TIDAK tepercaya.
 */

type OpsNamespace = ReturnType<SocketIoServer['of']>
type OpsSocket = Parameters<Parameters<OpsNamespace['on']>[1]>[0]
type Ack = (response: Record<string, unknown>) => void

/** Sumber & klien lokasi staf yang diterima kolom (CHECK di database). */
const SOURCES = ['gps', 'wifi', 'network', 'ip'] as const
const CLIENTS = ['android', 'desktop', 'web'] as const
type Source = (typeof SOURCES)[number]
type Client = (typeof CLIENTS)[number]

/** Jangan simpan lebih sering dari ini per user; kiriman lebih cepat diabaikan. */
const MIN_INTERVAL_MS = 15_000
/** Akurasi di atas ini (meter) dianggap "rendah". */
const LOW_CONFIDENCE_ACCURACY_M = 200

const lastSavedAt = new Map<number, number>()

export function canShareLocation(user: AuthenticatedUser): boolean {
    return user.permissions.includes('location.share')
}

function parseSource(value: unknown): Source {
    const text = typeof value === 'string' ? value.toLowerCase() : ''
    return (SOURCES as readonly string[]).includes(text) ? (text as Source) : 'gps'
}

function parseClient(value: unknown): Client {
    const text = typeof value === 'string' ? value.toLowerCase() : ''
    return (CLIENTS as readonly string[]).includes(text) ? (text as Client) : 'web'
}

/** Lokasi dari IP atau akurasi buruk tidak dapat dipercaya (rawan VPN / kasar). */
export function confidenceOf(source: Source, accuracy: number | null): 'high' | 'low' {
    if (source === 'ip') return 'low'
    if (accuracy === null || accuracy > LOW_CONFIDENCE_ACCURACY_M) return 'low'
    return 'high'
}

export function registerStaffLocationHandlers(
    _opsNs: OpsNamespace,
    socket: OpsSocket,
    user: AuthenticatedUser
) {
    const ack = (callback: unknown): Ack =>
        typeof callback === 'function' ? (callback as Ack) : () => {}

    socket.on('staff:location', async (payload: unknown, callback?: unknown) => {
        if (!canShareLocation(user)) {
            return ack(callback)({ ok: false, message: 'Anda tidak berwenang' })
        }

        const data = (payload && typeof payload === 'object' ? payload : {}) as Record<
            string,
            unknown
        >
        const latitude = cleanCoordinate(data.latitude, 90)
        const longitude = cleanCoordinate(data.longitude, 180)
        if (latitude === null || longitude === null) {
            return ack(callback)({ ok: false, message: 'Koordinat tidak valid' })
        }

        // Throttle per user: kiriman lebih cepat dari MIN_INTERVAL_MS tidak disimpan
        // (agen boleh mengirim sesering apa pun; server yang menjaga lajunya).
        const now = Date.now()
        const previous = lastSavedAt.get(user.id)
        if (previous !== undefined && now - previous < MIN_INTERVAL_MS) {
            return ack(callback)({ ok: true, throttled: true })
        }
        lastSavedAt.set(user.id, now)

        const source = parseSource(data.source)
        const client = parseClient(data.client)
        const accuracyRaw = cleanNumber(data.accuracy ?? data.accuracyMeters, 0, 999_999.99)
        const accuracy = accuracyRaw === null ? null : Math.round(accuracyRaw * 100) / 100
        const isMock = data.isMock === true
        const confidence = confidenceOf(source, accuracy)
        const capturedAt = DateTime.now()

        try {
            await StaffLocation.create({
                userId: user.id,
                organizationId: user.organizationId ?? null,
                latitude,
                longitude,
                accuracyMeters: accuracy,
                source,
                confidence,
                isMock,
                client,
                capturedAt,
                createdAt: capturedAt,
            })
        } catch (error) {
            logger.error('staff:location gagal disimpan', { error, userId: user.id })
            return ack(callback)({
                ok: false,
                message: 'Lokasi belum tersimpan, dicoba lagi otomatis',
            })
        }

        // Hanya ke ruang radar site staf (pemegang radar.view). Tanpa site, tidak disiarkan.
        if (user.organizationId) {
            socketManager.broadcastStaffLocation(user.organizationId, {
                user_id: user.id,
                name: user.name,
                latitude,
                longitude,
                accuracy_meters: accuracy,
                source,
                confidence,
                is_mock: isMock,
                client,
                captured_at: capturedAt.toISO(),
            })
        }
        ack(callback)({ ok: true })
    })
}

/** Lupakan state throttle saat user disconnect. */
export function forgetStaffLocationThrottle(userId: number) {
    lastSavedAt.delete(userId)
}
