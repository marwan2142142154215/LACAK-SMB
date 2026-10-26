import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * Status kerja Live Kerja & log kejadiannya -- padanan WorkPresence di
 * backend-api (dan realtime-gateway/app/services/live_status.ts). Urutan
 * prioritas: offline -> disconnected -> break -> alert -> camera_off ->
 * screen_off -> idle -> working. Ubah ketiganya bersamaan.
 */

export type WorkStatus =
    | 'working'
    | 'idle'
    | 'break'
    | 'disconnected'
    | 'screen_off'
    | 'camera_off'
    | 'offline'
    | 'alert'

export const DISCONNECTED_AFTER_SECONDS = 75
export const ALERT_GRACE_SECONDS = 60

export const STATE_EVENTS = {
    camera_active: ['camera_start', 'camera_stop'],
    screen_active: ['screen_start', 'screen_stop'],
    on_break: ['break_start', 'break_end'],
    idle: ['idle_start', 'idle_end'],
    // Cek wajah: hanya kejadian log, tidak mengubah status kerja.
    face_missing: ['face_lost', 'face_back'],
} as const

export type StateColumn = keyof typeof STATE_EVENTS

export type WorkSessionRow = {
    id: number
    user_id: number
    // NULL = sesi leader (ruang leader global, lihat LEADERS_ROOM).
    organization_id: number | null
    started_at: Date
    last_heartbeat_at: Date
    ended_at: Date | null
    end_reason: string | null
    disconnected_at: Date | null
    camera_active: boolean
    screen_active: boolean
    on_break: boolean
    idle: boolean
    face_missing: boolean
    user_name?: string | null
}

export function statusOf(session: WorkSessionRow | null, now: Date = new Date()): WorkStatus {
    if (!session || session.ended_at) return 'offline'

    const secondsAgo = (date: Date) => (now.getTime() - date.getTime()) / 1000

    if (
        session.disconnected_at ||
        secondsAgo(session.last_heartbeat_at) > DISCONNECTED_AFTER_SECONDS
    ) {
        return 'disconnected'
    }
    if (session.on_break) return 'break'
    if (!session.camera_active && !session.screen_active) {
        return secondsAgo(session.started_at) < ALERT_GRACE_SECONDS ? 'camera_off' : 'alert'
    }
    if (!session.camera_active) return 'camera_off'
    if (!session.screen_active) return 'screen_off'
    if (session.idle) return 'idle'
    return 'working'
}

type Client = typeof db | TransactionClientContract

const SESSION_COLUMNS = ['work_sessions.*', 'users.name as user_name']

export function openSessions(client: Client = db) {
    return client
        .from('work_sessions')
        .leftJoin('users', 'users.id', 'work_sessions.user_id')
        .whereNull('work_sessions.ended_at')
        .select(SESSION_COLUMNS)
}

export async function openSessionOf(userId: number): Promise<WorkSessionRow | null> {
    return (await openSessions().where('work_sessions.user_id', userId).first()) ?? null
}

/** Catat kejadian dengan status staf saat ini (sesudah kejadian). */
export async function record(
    userId: number,
    type: string,
    session: WorkSessionRow | null,
    organizationId: number | null = null,
    client: Client = db
) {
    const now = new Date()
    await client.table('work_session_events').insert({
        user_id: userId,
        organization_id: session?.organization_id ?? organizationId,
        work_session_id: session?.id ?? null,
        type,
        status: statusOf(session?.ended_at ? null : session, now),
        occurred_at: now,
        created_at: now,
        updated_at: now,
    })
}

/**
 * Laporan status dari aplikasi staf (heartbeat): satu kejadian untuk tiap
 * kolom yang benar-benar berubah, berurutan supaya status di tiap baris log
 * adalah status tepat setelah perubahan itu.
 */
export async function applyState(
    session: WorkSessionRow,
    state: Partial<Record<StateColumn, boolean>>
): Promise<WorkSessionRow> {
    const now = new Date()
    const wasDisconnected = session.disconnected_at !== null

    await db
        .from('work_sessions')
        .where('id', session.id)
        .update({ last_heartbeat_at: now, disconnected_at: null, updated_at: now })
    session.last_heartbeat_at = now
    session.disconnected_at = null

    if (wasDisconnected) {
        await record(session.user_id, 'reconnected', session)
    }

    for (const column of Object.keys(STATE_EVENTS) as StateColumn[]) {
        const value = state[column]
        if (value === undefined || session[column] === value) continue

        await db
            .from('work_sessions')
            .where('id', session.id)
            .update({ [column]: value, updated_at: now })
        session[column] = value
        await record(session.user_id, STATE_EVENTS[column][value ? 0 : 1], session)
    }

    return session
}

/** Tutup sesi: catat layar/kamera berhenti, lalu kejadian penutupnya. */
export async function closeSession(
    session: WorkSessionRow,
    reason: string,
    eventType: string
): Promise<WorkSessionRow> {
    const now = new Date()

    for (const [column, type] of [
        ['screen_active', 'screen_stop'],
        ['camera_active', 'camera_stop'],
    ] as const) {
        if (session[column]) {
            await db
                .from('work_sessions')
                .where('id', session.id)
                .update({ [column]: false, updated_at: now })
            session[column] = false
            await record(session.user_id, type, session)
        }
    }

    await db
        .from('work_sessions')
        .where('id', session.id)
        .update({ ended_at: now, end_reason: reason, updated_at: now })
    session.ended_at = now
    session.end_reason = reason
    await record(session.user_id, eventType, session)

    return session
}

/** Bentuk yang sama dengan WorkSessionResource di backend-api. */
export function sessionResource(session: WorkSessionRow, now: Date = new Date()) {
    return {
        id: session.id,
        user_id: session.user_id,
        ...(session.user_name !== undefined ? { user_name: session.user_name } : {}),
        organization_id: session.organization_id,
        participant_identity: `user-${session.user_id}`,
        started_at: session.started_at,
        last_heartbeat_at: session.last_heartbeat_at,
        ended_at: session.ended_at,
        camera_active: session.camera_active,
        screen_active: session.screen_active,
        on_break: session.on_break,
        idle: session.idle,
        face_missing: session.face_missing,
        status: statusOf(session, now),
        end_reason: session.end_reason,
    }
}

export type PresenceEvent = {
    id: number
    user_id: number
    user_name: string | null
    organization_id: number | null
    type: string
    status: WorkStatus
    occurred_at: Date
}

/**
 * Ringkasan per staf untuk satu rentang: jam kerja aktual (selang berstatus
 * working), istirahat, login pertama, dan status terakhir. Padanan
 * WorkPresence::summarize().
 *
 * @param events kejadian dalam rentang, urut waktu
 * @param before kejadian terakhir sebelum `from`, per user_id
 */
export function summarize(
    events: PresenceEvent[],
    before: Map<number, PresenceEvent>,
    from: Date,
    to: Date,
    now: Date = new Date()
) {
    const end = Math.min(to.getTime(), now.getTime())
    const byUser = new Map<number, PresenceEvent[]>()
    for (const event of events) {
        if (!byUser.has(event.user_id)) byUser.set(event.user_id, [])
        byUser.get(event.user_id)!.push(event)
    }
    for (const userId of before.keys()) {
        if (!byUser.has(userId)) byUser.set(userId, [])
    }

    const summary = [...byUser].map(([userId, userEvents]) => {
        let status: string = before.get(userId)?.status ?? 'offline'
        let cursor = from.getTime()
        const totals: Record<string, number> = { working: 0, break: 0 }
        // Wajah hilang: dihitung dari face_lost sampai face_back / sesi selesai.
        let faceLostAt: number | null = before.get(userId)?.type === 'face_lost' ? cursor : null
        let faceMissingSeconds = 0
        let faceLostCount = 0
        const closeFace = (at: number) => {
            if (faceLostAt === null) return
            faceMissingSeconds += Math.floor(Math.max(0, at - faceLostAt) / 1000)
            faceLostAt = null
        }

        for (const event of userEvents) {
            const at = event.occurred_at.getTime()
            totals[status] = (totals[status] ?? 0) + Math.floor(Math.abs(at - cursor) / 1000)
            status = event.status
            cursor = at
            if (event.type === 'face_lost') {
                faceLostCount++
                faceLostAt ??= at
            } else if (event.type === 'face_back' || event.status === 'offline') {
                closeFace(at)
            }
        }
        if (cursor < end) {
            totals[status] = (totals[status] ?? 0) + Math.floor((end - cursor) / 1000)
        }
        closeFace(end)

        const reference = userEvents[0] ?? before.get(userId)
        const last = userEvents[userEvents.length - 1] ?? before.get(userId)
        const firstLogin = userEvents.find((event) => event.type === 'login')

        return {
            user_id: userId,
            user_name: reference?.user_name ?? null,
            organization_id: last?.organization_id ?? null,
            work_seconds: totals.working,
            break_seconds: totals.break,
            face_missing_seconds: faceMissingSeconds,
            face_lost_count: faceLostCount,
            first_login_at: firstLogin ? firstLogin.occurred_at.toISOString() : null,
            status,
        }
    })

    return summary.sort((a, b) => (a.user_name ?? '').localeCompare(b.user_name ?? ''))
}
