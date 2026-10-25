import {
    STATE_EVENTS,
    statusOf,
    type StateColumn,
    type WorkSessionRow,
} from '#services/live_status'

/**
 * Status Live Kerja di database -- padanan WorkPresence::applyState() &
 * record() di backend-api, untuk heartbeat yang kini lewat socket (bukan
 * POST /live/sessions/heartbeat). Tabelnya sama: work_sessions &
 * work_session_events; sesi tetap dibuka/ditutup oleh backend-api.
 */

type Db = (typeof import('@adonisjs/lucid/services/db'))['default']

// Diimpor dinamis: service db butuh app sudah boot (lihat catatan di log.ts).
let dbPromise: Promise<Db> | null = null
function getDb(): Promise<Db> {
    dbPromise ??= import('@adonisjs/lucid/services/db').then(({ default: db }) => db)
    return dbPromise
}

export type LiveSession = WorkSessionRow & { user_name: string | null; end_reason: string | null }

const SESSION_COLUMNS = [
    'work_sessions.id',
    'work_sessions.user_id',
    'work_sessions.organization_id',
    'work_sessions.started_at',
    'work_sessions.last_heartbeat_at',
    'work_sessions.ended_at',
    'work_sessions.end_reason',
    'work_sessions.disconnected_at',
    'work_sessions.camera_active',
    'work_sessions.screen_active',
    'work_sessions.on_break',
    'work_sessions.idle',
    'users.name as user_name',
]

// Builder Lucid bisa di-await (thenable), jadi JANGAN dikembalikan dari
// fungsi async -- di-await sekali langsung jalan sebagai query.
function openSessionsQuery(db: Db) {
    return db
        .from('work_sessions')
        .join('users', 'users.id', 'work_sessions.user_id')
        .whereNull('work_sessions.ended_at')
        .select(SESSION_COLUMNS)
}

export async function openSessionOf(userId: number): Promise<LiveSession | null> {
    const db = await getDb()
    return (await openSessionsQuery(db).where('work_sessions.user_id', userId).first()) ?? null
}

/** Sesi terbuka di site-site ini, plus sesi leader (organization_id NULL) kalau diminta. */
export async function openSessionsIn(
    organizationIds: number[],
    includeLeaders = false
): Promise<LiveSession[]> {
    if (!organizationIds.length && !includeLeaders) return []
    const db = await getDb()
    return openSessionsQuery(db).where((query) => {
        if (organizationIds.length) query.whereIn('work_sessions.organization_id', organizationIds)
        if (includeLeaders) query.orWhereNull('work_sessions.organization_id')
    })
}

/**
 * Laporan status dari staf yang sedang siaran (tiap 30 detik + saat ada
 * perubahan). null = tidak ada sesi terbuka (sudah ditutup server) -> staf
 * wajib berhenti menyiarkan, sama seperti 404 dari heartbeat HTTP.
 */
export async function applyReportedState(
    userId: number,
    state: Partial<Record<StateColumn, boolean>>
): Promise<LiveSession | null> {
    const session = await openSessionOf(userId)
    if (!session) return null

    const db = await getDb()
    const now = new Date()
    const wasDisconnected = session.disconnected_at !== null

    await db
        .from('work_sessions')
        .where('id', session.id)
        .update({ last_heartbeat_at: now, disconnected_at: null, updated_at: now })
    session.last_heartbeat_at = now
    session.disconnected_at = null

    if (wasDisconnected) {
        await record(session, 'reconnected', now)
    }

    // Satu kolom per langkah, supaya status di tiap baris log adalah status
    // tepat setelah perubahan itu saja.
    for (const column of Object.keys(STATE_EVENTS) as StateColumn[]) {
        const value = state[column]
        if (value === undefined || session[column] === value) continue

        await db
            .from('work_sessions')
            .where('id', session.id)
            .update({ [column]: value, updated_at: now })
        session[column] = value
        await record(session, STATE_EVENTS[column][value ? 0 : 1], now)
    }

    return session
}

async function record(session: LiveSession, type: string, now: Date) {
    const db = await getDb()
    await db.table('work_session_events').insert({
        user_id: session.user_id,
        organization_id: session.organization_id,
        work_session_id: session.id,
        type,
        status: statusOf(session, now),
        occurred_at: now,
        created_at: now,
        updated_at: now,
    })
}

/**
 * Masih punya token login berlaku? Staf yang Selesai kerja tapi tetap login
 * tampil 'online' di daftar staf, bukan 'offline' (sama dengan roster
 * /live/overview). Token login selalu punya expires_at; token akun layanan tidak.
 */
export async function hasActiveLogin(userId: number): Promise<boolean> {
    const db = await getDb()
    const row = await db
        .from('personal_access_tokens')
        .where('tokenable_type', 'App\\Models\\User')
        .where('tokenable_id', userId)
        .where('expires_at', '>', new Date())
        .first()
    return Boolean(row)
}

/** Bentuk yang sama dengan WorkSessionResource di backend-api. */
export function sessionPayload(session: LiveSession, now: Date = new Date()) {
    return {
        id: session.id,
        user_id: session.user_id,
        user_name: session.user_name,
        organization_id: session.organization_id,
        participant_identity: `user-${session.user_id}`,
        started_at: session.started_at,
        last_heartbeat_at: session.last_heartbeat_at,
        ended_at: session.ended_at,
        camera_active: session.camera_active,
        screen_active: session.screen_active,
        on_break: session.on_break,
        idle: session.idle,
        status: statusOf(session, now),
        end_reason: session.end_reason,
    }
}
