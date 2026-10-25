import type { Server as SocketIoServer } from 'socket.io'
import logger from '#services/log'
import type { AuthenticatedUser } from '#services/backend_api_client'
import { parseReportedState, statusOf, type WorkStatus } from '#services/live_status'
import {
    applyReportedState,
    hasActiveLogin,
    openSessionsIn,
    sessionPayload,
    type LiveSession,
} from '#services/live_presence'

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
const LEADERS_ROOM = `${ROOM_PREFIX}leaders`

/** Room status per site; null = ruang leader (sesi leader tanpa site). */
export const liveRoom = (organizationId: number | null) =>
    organizationId === null ? LEADERS_ROOM : `${ROOM_PREFIX}${organizationId}`

/** Ruang leader hanya ditonton peran di atas leader: admin & root. */
export function canWatchLeaders(user: AuthenticatedUser): boolean {
    return ['super_admin', 'admin'].some((role) => user.roles.includes(role))
}

/** Leader menyiarkan ke ruang leader; staf butuh izin live.broadcast. */
export function canBroadcast(user: AuthenticatedUser): boolean {
    return user.permissions.includes('live.broadcast') || user.roles.includes('leader')
}

/**
 * Staf biasa (peran staff_viewer saja) hanya melihat dirinya sendiri: tidak
 * ikut room status site (status sendiri datang dari balasan `live:state`).
 * Sama dengan seesOnlySelf() di backend-adonis.
 */
export function seesOnlySelf(user: AuthenticatedUser): boolean {
    return (
        user.roles.includes('staff_viewer') &&
        !['super_admin', 'admin', 'leader', 'site_admin'].some((role) => user.roles.includes(role))
    )
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

/** Status terakhir yang sudah dikirim, per sesi kerja terbuka. */
const lastKnown = new Map<
    number,
    { userId: number; organizationId: number | null; status: WorkStatus }
>()

type MediaTransport = 'udp' | 'tcp'

/**
 * Jalur video tiap staf yang siaran (dilaporkan browser-nya lewat
 * `live:state`): 'tcp' = UDP terblokir (biasanya VPN), jauh lebih berat untuk
 * server LiveKit. Hanya di memori -- penanda tampilan, bukan data kerja.
 */
const transports = new Map<number, { organizationId: number | null; transport: MediaTransport }>()

export function parseTransport(payload: unknown): MediaTransport | null {
    const value = (payload as { transport?: unknown } | null)?.transport
    return value === 'udp' || value === 'tcp' ? value : null
}

/** identity peserta -> jalur video, untuk staf di site-site ini (null = leader). */
function transportsIn(organizationIds: Array<number | null>): Record<string, MediaTransport> {
    const snapshot: Record<string, MediaTransport> = {}
    for (const [userId, entry] of transports) {
        if (organizationIds.includes(entry.organizationId)) {
            snapshot[`user-${userId}`] = entry.transport
        }
    }
    return snapshot
}

function publishSession(opsNs: OpsNamespace, session: LiveSession, now: Date) {
    const status = statusOf(session, now)
    lastKnown.set(session.id, {
        userId: session.user_id,
        organizationId: session.organization_id,
        status,
    })
    opsNs.to(liveRoom(session.organization_id)).emit('live:status', {
        organization_id: session.organization_id,
        user_id: session.user_id,
        participant_identity: `user-${session.user_id}`,
        status,
        started_at: session.started_at,
        session: sessionPayload(session, now),
        transport: transports.get(session.user_id)?.transport ?? null,
    })
}

async function publishEnded(opsNs: OpsNamespace, userId: number, organizationId: number | null) {
    // Selesai kerja tapi masih login = 'online'; logout / sesi habis = 'offline'.
    const status = (await hasActiveLogin(userId)) ? 'online' : 'offline'
    transports.delete(userId)
    opsNs.to(liveRoom(organizationId)).emit('live:status', {
        organization_id: organizationId,
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
    // null = ruang leader.
    const watching = new Set<number | null>()

    socket.on(
        'live:watch',
        (payload: { organizationIds?: unknown; leaders?: unknown }, callback?: unknown) => {
            const requested = Array.isArray(payload?.organizationIds) ? payload.organizationIds : []
            const allowed: Array<number | null> = requested
                .map(Number)
                .filter((id) => Number.isInteger(id) && id > 0 && canWatchSite(user, id))
            const leaders = payload?.leaders === true && canWatchLeaders(user)
            if (leaders) allowed.push(null)

            for (const id of watching) {
                if (!allowed.includes(id)) socket.leave(liveRoom(id))
            }
            watching.clear()
            for (const id of allowed) {
                socket.join(liveRoom(id))
                watching.add(id)
            }

            ack(callback)({
                ok: true,
                organizationIds: allowed.filter((id) => id !== null),
                leaders,
                transports: transportsIn(allowed),
            })
        }
    )

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
                transports.set(user.id, { organizationId: session.organization_id, transport })
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
            const rooms = [...opsNs.adapter.rooms.keys()].filter((room) =>
                room.startsWith(ROOM_PREFIX)
            )
            const leadersWatched = rooms.includes(LEADERS_ROOM)
            const watched = rooms
                .filter((room) => room !== LEADERS_ROOM)
                .map((room) => Number(room.slice(ROOM_PREFIX.length)))
            const watchedSet = new Set<number | null>(watched)
            if (leadersWatched) watchedSet.add(null)
            const sessions = await openSessionsIn(watched, leadersWatched)
            const openIds = new Set(sessions.map((session) => session.id))
            const now = new Date()

            // Yang berakhir dulu, baru yang baru/berubah -- staf yang langsung
            // mulai sesi baru tidak boleh tertimpa "offline".
            for (const [sessionId, known] of lastKnown) {
                if (!watchedSet.has(known.organizationId)) {
                    lastKnown.delete(sessionId)
                } else if (!openIds.has(sessionId)) {
                    lastKnown.delete(sessionId)
                    await publishEnded(opsNs, known.userId, known.organizationId)
                }
            }

            for (const session of sessions) {
                if (lastKnown.get(session.id)?.status !== statusOf(session, now)) {
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
