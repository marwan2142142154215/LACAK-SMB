import type { Server as SocketIoServer } from 'socket.io'
import logger from '#services/Log'
import type { AuthenticatedUser } from '#services/BackendApiClient'
import { parseReportedState, statusOf, type WorkStatus } from '#services/LiveStatus'
import {
    applyReportedState,
    hasActiveLogin,
    openSessionsIn,
    sessionPayload,
    type LiveSession,
} from '#services/LivePresence'

/**
 * Live Kerja lewat socket /ops, menggantikan dua polling HTTP:
 *
 * - Staf yang siaran mengirim `live:state` (tiap 30 detik + saat kamera/
 *   layar/istirahat/idle berubah), bukan POST /live/sessions/heartbeat.
 * - Penonton bergabung ke room `live:{site}` lewat `live:watch` dan menerima
 *   `live:status` HANYA saat status seorang staf berubah, bukan menarik
 *   GET /live/overview tiap 15 detik dari setiap tab.
 *
 * Perubahan yang tidak lewat socket (Mulai/Selesai kerja & logout di
 * backend-api, sesi ditutup timeout, status "terputus" karena waktu berlalu)
 * ditangkap sweeper: satu query per SWEEP_INTERVAL_MS untuk semua site yang
 * sedang ditonton, bukan satu per tab.
 */

type OpsNamespace = ReturnType<SocketIoServer['of']>
type OpsSocket = Parameters<Parameters<OpsNamespace['on']>[1]>[0]
type Ack = (response: Record<string, unknown>) => void

const SWEEP_INTERVAL_MS = 10_000
const ROOM_PREFIX = 'live:'
/** Penanda Ruang pusat di nama room (penyiar yang tidak terikat site). */
const CENTRAL_KEY = 'pusat'
/** Sama dengan UNKNOWN_LIVE_ROLE di backend-adonis (sesi tanpa live_role). */
const UNKNOWN_LIVE_ROLE = 'lainnya'
const ROLE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/

/** Satu room status = satu site (null = Ruang pusat) + satu peran penyiar. */
export type LiveRoomRef = { organizationId: number | null; role: string }

export const roleOf = (session: { live_role: string | null }) =>
    session.live_role ?? UNKNOWN_LIVE_ROLE

/**
 * Room status `live:{site}:{peran}` / `live:pusat:{peran}` -- dipisah per peran
 * seperti room LiveKit-nya, supaya status penyiar hanya sampai ke penonton yang
 * boleh menonton peran itu.
 */
export const liveRoom = (organizationId: number | null, role: string) =>
    `${ROOM_PREFIX}${organizationId ?? CENTRAL_KEY}:${role}`

export function parseLiveRoom(room: string): LiveRoomRef | null {
    const match = /^live:(pusat|\d+):([a-z][a-z0-9_]*)$/.exec(room)
    if (!match) return null
    return {
        organizationId: match[1] === CENTRAL_KEY ? null : Number(match[1]),
        role: match[2],
    }
}

/** Ruang pusat (siaran tanpa site) hanya untuk pemegang izin live.watch-central. */
export function canWatchCentral(user: AuthenticatedUser): boolean {
    return user.permissions.includes('live.watch-central')
}

/** Semua peran bisa Live asal memegang izin live.broadcast. */
export function canBroadcast(user: AuthenticatedUser): boolean {
    return user.permissions.includes('live.broadcast')
}

/** Hak tonton per peran (roles.watchable_roles); null = semua peran. */
export function canWatchRole(user: AuthenticatedUser, role: string): boolean {
    return !user.watchRoles || user.watchRoles.includes(role)
}

/**
 * Tanpa izin live.roster, user hanya melihat dirinya sendiri: tidak ikut room
 * status site (status sendiri datang dari balasan `live:state`). Sama dengan
 * seesOnlySelf() di backend-adonis.
 */
export function seesOnlySelf(user: AuthenticatedUser): boolean {
    return !user.permissions.includes('live.roster')
}

/** Sama dengan aturan watchableSites() di WorkSessionsController backend-adonis. */
export function canWatchSite(user: AuthenticatedUser, organizationId: number): boolean {
    if (!user.permissions.includes('live.watch') || seesOnlySelf(user)) return false
    if (user.roles.includes('super_admin')) return true
    if (user.roles.includes('admin') || user.roles.includes('leader')) {
        return user.accessibleOrganizationIds.includes(organizationId)
    }
    return user.organizationId === organizationId
}

/** Boleh bergabung ke room status ini: lokasinya (site/pusat) DAN perannya boleh ditonton. */
export function canWatchRoom(user: AuthenticatedUser, room: LiveRoomRef): boolean {
    if (!canWatchRole(user, room.role)) return false
    if (room.organizationId !== null) return canWatchSite(user, room.organizationId)
    return user.permissions.includes('live.watch') && !seesOnlySelf(user) && canWatchCentral(user)
}

/** Isian `live:watch` -> LiveRoomRef yang sah, atau null. */
function parseRoomRequest(value: unknown): LiveRoomRef | null {
    const item = value as { organizationId?: unknown; role?: unknown } | null
    const role = typeof item?.role === 'string' ? item.role : ''
    if (!ROLE_PATTERN.test(role) && role !== UNKNOWN_LIVE_ROLE) return null
    if (item?.organizationId === null) return { organizationId: null, role }
    const organizationId = Number(item?.organizationId)
    return Number.isInteger(organizationId) && organizationId > 0 ? { organizationId, role } : null
}

/** Status terakhir yang sudah dikirim, per sesi kerja terbuka. */
const lastKnown = new Map<
    number,
    {
        userId: number
        organizationId: number | null
        room: string
        status: WorkStatus
        faceMissing: boolean
    }
>()

type MediaTransport = 'udp' | 'tcp'

/**
 * Jalur video tiap staf yang siaran (dilaporkan browser-nya lewat
 * `live:state`): 'tcp' = UDP terblokir (biasanya VPN), jauh lebih berat untuk
 * server LiveKit. Hanya di memori -- penanda tampilan, bukan data kerja.
 */
const transports = new Map<number, { room: string; transport: MediaTransport }>()

export function parseTransport(payload: unknown): MediaTransport | null {
    const value = (payload as { transport?: unknown } | null)?.transport
    return value === 'udp' || value === 'tcp' ? value : null
}

/** identity peserta -> jalur video, untuk penyiar di room-room status ini. */
function transportsIn(rooms: string[]): Record<string, MediaTransport> {
    const snapshot: Record<string, MediaTransport> = {}
    for (const [userId, entry] of transports) {
        if (rooms.includes(entry.room)) snapshot[`user-${userId}`] = entry.transport
    }
    return snapshot
}

function publishSession(opsNs: OpsNamespace, session: LiveSession, now: Date) {
    const status = statusOf(session, now)
    const room = liveRoom(session.organization_id, roleOf(session))
    lastKnown.set(session.id, {
        userId: session.user_id,
        organizationId: session.organization_id,
        room,
        status,
        faceMissing: session.face_missing,
    })
    opsNs.to(room).emit('live:status', {
        organization_id: session.organization_id,
        live_role: roleOf(session),
        user_id: session.user_id,
        participant_identity: `user-${session.user_id}`,
        status,
        started_at: session.started_at,
        session: sessionPayload(session, now),
        transport: transports.get(session.user_id)?.transport ?? null,
    })
}

async function publishEnded(
    opsNs: OpsNamespace,
    userId: number,
    organizationId: number | null,
    room: string
) {
    // Selesai kerja tapi masih login = 'online'; logout / sesi habis = 'offline'.
    const status = (await hasActiveLogin(userId)) ? 'online' : 'offline'
    transports.delete(userId)
    opsNs.to(room).emit('live:status', {
        organization_id: organizationId,
        live_role: parseLiveRoom(room)?.role ?? null,
        user_id: userId,
        participant_identity: `user-${userId}`,
        status,
        started_at: null,
        session: null,
        transport: null,
    })
}

export function registerLiveHandlers(
    opsNs: OpsNamespace,
    socket: OpsSocket,
    user: AuthenticatedUser
) {
    const ack = (callback: unknown): Ack =>
        typeof callback === 'function' ? (callback as Ack) : () => {}
    // Nama room status yang sedang diikuti socket ini.
    const watching = new Set<string>()

    // Penonton memilih room (site/pusat + peran); yang tidak boleh ditonton dibuang diam-diam.
    socket.on('live:watch', (payload: { rooms?: unknown }, callback?: unknown) => {
        const requested = Array.isArray(payload?.rooms) ? payload.rooms : []
        const allowed = new Map<string, LiveRoomRef>()
        for (const item of requested) {
            const ref = parseRoomRequest(item)
            if (ref && canWatchRoom(user, ref))
                allowed.set(liveRoom(ref.organizationId, ref.role), ref)
        }

        for (const room of watching) {
            if (!allowed.has(room)) socket.leave(room)
        }
        watching.clear()
        for (const room of allowed.keys()) {
            socket.join(room)
            watching.add(room)
        }

        ack(callback)({
            ok: true,
            rooms: [...allowed.values()],
            transports: transportsIn([...allowed.keys()]),
        })
    })

    socket.on('live:state', async (payload: unknown, callback?: unknown) => {
        if (!canBroadcast(user)) {
            return ack(callback)({ ok: false, message: 'Anda tidak berwenang' })
        }

        try {
            const session = await applyReportedState(user.id, parseReportedState(payload))
            if (!session) {
                socket.data.liveBroadcasting = false
                return ack(callback)({ ok: false, closed: true })
            }

            // Selama siaran, sesi login diperpanjang lewat cek ulang berkala
            // di socket.ts (heartbeat HTTP yang dulu melakukannya sudah tidak ada).
            socket.data.liveBroadcasting = true
            const transport = parseTransport(payload)
            if (transport) {
                const room = liveRoom(session.organization_id, roleOf(session))
                transports.set(user.id, { room, transport })
            }
            const now = new Date()
            ack(callback)({ ok: true, status: statusOf(session, now) })
            publishSession(opsNs, session, now)
        } catch (error) {
            logger.error('gagal menyimpan status Live Kerja', { error, userId: user.id })
            ack(callback)({ ok: false, message: 'Status belum tersimpan, dicoba lagi otomatis' })
        }
    })
}

export function startLiveSweeper(opsNs: OpsNamespace): () => void {
    let running = false

    const timer = setInterval(async () => {
        if (running) return
        running = true
        try {
            const watched = new Set(
                [...opsNs.adapter.rooms.keys()].filter((room) => room.startsWith(ROOM_PREFIX))
            )
            const refs = [...watched]
                .map(parseLiveRoom)
                .filter((ref): ref is LiveRoomRef => ref !== null)
            const siteIds = [
                ...new Set(
                    refs.map((ref) => ref.organizationId).filter((id): id is number => id !== null)
                ),
            ]
            const centralWatched = refs.some((ref) => ref.organizationId === null)
            const sessions = await openSessionsIn(siteIds, centralWatched)
            const openIds = new Set(sessions.map((session) => session.id))
            const now = new Date()

            // Yang berakhir dulu, baru yang baru/berubah -- staf yang langsung
            // mulai sesi baru tidak boleh tertimpa "offline".
            for (const [sessionId, known] of lastKnown) {
                if (!watched.has(known.room)) {
                    lastKnown.delete(sessionId)
                } else if (!openIds.has(sessionId)) {
                    lastKnown.delete(sessionId)
                    await publishEnded(opsNs, known.userId, known.organizationId, known.room)
                }
            }

            for (const session of sessions) {
                // Site-nya ditonton, tapi room peran ini tidak: tidak ada yang perlu dikabari.
                if (!watched.has(liveRoom(session.organization_id, roleOf(session)))) continue
                // Wajah hilang/kembali dari APK (heartbeat HTTP) juga diteruskan.
                const known = lastKnown.get(session.id)
                if (
                    known?.status !== statusOf(session, now) ||
                    known.faceMissing !== session.face_missing
                ) {
                    publishSession(opsNs, session, now)
                }
            }
        } catch (error) {
            logger.error('sweeper status Live Kerja gagal', { error })
        } finally {
            running = false
        }
    }, SWEEP_INTERVAL_MS)

    return () => clearInterval(timer)
}
