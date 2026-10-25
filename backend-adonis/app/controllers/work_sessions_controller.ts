import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import vine from '@vinejs/vine'
import { accessOf, can, hasRole, type Access } from '#services/access'
import { fail, success } from '#services/api_response'
import { laravelDate, logModelEvent, WORK_SESSION_MORPH } from '#services/activity_log'
import { laravelUrlSigner, LARAVEL_USER_MORPH } from '#services/laravel/index'
import {
    broadcasterToken,
    LEADERS_ROOM,
    liveKitConfig,
    removeBroadcaster,
    roomForSession,
    viewerToken,
} from '#services/livekit'
import {
    authorizedOrganizationId,
    hasCrossOrganizationAccess,
    hasGrantBasedAccess,
} from '#services/organization_scope'
import {
    applyState,
    closeSession,
    openSessionOf,
    openSessions,
    record,
    sessionResource,
    statusOf,
    summarize,
    type PresenceEvent,
    type WorkSessionRow,
} from '#services/work_presence'

/** Umur cache GET /live/overview per kumpulan site, sama dengan backend-api. */
const OVERVIEW_CACHE_SECONDS = 5

const heartbeatValidator = vine.compile(
    vine.object({
        camera_active: vine.boolean().optional(),
        screen_active: vine.boolean().optional(),
        on_break: vine.boolean().optional(),
        idle: vine.boolean().optional(),
    })
)

const activityValidator = vine.compile(
    vine.object({
        organization_id: vine.number().withoutDecimals().nullable().optional(),
        all_sites: vine.boolean().nullable().optional(),
        from: vine.string(),
        to: vine.string(),
    })
)

/**
 * Live Kerja -- padanan WorkSessionController di backend-api, kontrak sama.
 * Status realtime (heartbeat & push status) sudah lewat realtime-gateway;
 * endpoint di sini tetap dipakai untuk muat awal, APK Live, dan cadangan.
 */
export default class WorkSessionsController {
    /** Site yang boleh ditonton, beserta jumlah staf yang sedang live. */
    async sites(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) return forbidden(ctx)

        return success('Site yang bisa ditonton', await watchableSites(access))
    }

    /** Semua staf live di semua site yang boleh ditonton + status tiap staf. */
    async overview(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) return forbidden(ctx)

        const sites = await watchableSites(access)
        const siteIds = sites.map((site) => site.id).sort((a, b) => a - b)

        // Dipanggil oleh setiap tab Live Kerja & Aktivitas; hasilnya sama
        // untuk semua yang menonton kumpulan site yang sama.
        const live = await cachedOverview(`live:overview:${siteIds.join(',')}`, async () => {
            const sessions = await openSessionsIn(siteIds)
            return {
                items: sessions.map((session) => sessionResource(session)),
                roster: await rosterFor(siteIds, sessions),
            }
        })

        // Ruang leader: hanya untuk admin & root (leader & staf tidak melihatnya).
        const leaders = canWatchLeaders(access)
            ? await cachedOverview('live:overview:leaders', async () => {
                  const sessions: WorkSessionRow[] = await openSessions()
                      .whereNull('work_sessions.organization_id')
                      .orderBy('work_sessions.started_at')
                  return {
                      items: sessions.map((session) => sessionResource(session)),
                      roster: await leaderRoster(sessions),
                  }
              })
            : null

        return success('Semua staf yang sedang live', { sites, ...live, leaders })
    }

    /** Staf live di satu site, status semua staf site itu, dan sesi milik user ini. */
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) return forbidden(ctx)

        // Leader tanpa site: cukup sesi kerjanya sendiri (melanjutkan siaran
        // setelah reload) -- siaran leader ada di ruang leader, bukan site.
        if (requestedOrganizationId(ctx) === null && hasRole(access, 'leader')) {
            const mine = await openSessionOf(access.userId)
            return success('Staf yang sedang live', {
                organization_id: null,
                items: [],
                roster: [],
                my_session: mine ? sessionResource(withoutUserName(mine)) : null,
            })
        }

        const organizationId = authorizedOrganizationId(access, requestedOrganizationId(ctx))
        if (organizationId === null) {
            return ctx.response.status(403).send(fail('Pilih site yang boleh Anda tonton'))
        }

        const sessions = await openSessionsIn([organizationId])
        const mine = await openSessionOf(access.userId)

        return success('Staf yang sedang live', {
            organization_id: organizationId,
            items: sessions.map((session) => sessionResource(session)),
            roster: await rosterFor([organizationId], sessions),
            my_session: mine ? sessionResource(withoutUserName(mine)) : null,
        })
    }

    async start(ctx: HttpContext) {
        const access = await accessOf(ctx)
        // Leader menyiarkan ke ruang leader global (organization_id NULL);
        // staf selalu ke site "rumah"-nya -- tidak ada parameter site.
        const asLeader = hasRole(access, 'leader')
        if (!asLeader && !can(access, 'live.broadcast')) return forbidden(ctx)

        const user = ctx.authUser!
        if (!asLeader && user.organizationId === null) {
            return ctx.response
                .status(422)
                .send(fail('Akun Anda tidak terikat ke site mana pun, tidak bisa memulai siaran'))
        }

        // Layar & kamera wajib -- hanya dashboard di komputer yang bisa
        // membagikan seluruh layar. APK Live & browser HP ditolak.
        if (ctx.request.input('device') !== 'computer') {
            return ctx.response
                .status(422)
                .send(
                    fail(
                        'Live Kerja hanya bisa dimulai dari komputer (Chrome atau Edge): layar & kamera wajib dibagikan.'
                    )
                )
        }

        const session =
            (await openSessionOf(user.id)) ??
            (await createSession(ctx, user.id, asLeader ? null : user.organizationId))

        // Sesi lama dilanjutkan memakai site yang tercatat di sesi.
        return ctx.response.status(201).send(
            success('Mulai kerja -- siaran kamera aktif', {
                session: sessionResource(withoutUserName(session)),
                ...connectionDetails(
                    session.organization_id,
                    broadcasterToken(session.organization_id, user.id, user.name)
                ),
            })
        )
    }

    /** Cadangan heartbeat HTTP (dashboard memakai socket gateway; APK Live memakai ini). */
    async heartbeat(ctx: HttpContext) {
        const state = await ctx.request.validateUsing(heartbeatValidator)

        const session = await openSessionOf(ctx.authUser!.id)
        if (!session) {
            return ctx.response.status(404).send(fail('Tidak ada sesi kerja yang aktif'))
        }

        await applyState(session, state)

        return success('Heartbeat diterima', sessionResource(withoutUserName(session)))
    }

    async end(ctx: HttpContext) {
        const session = await openSessionOf(ctx.authUser!.id)
        if (!session) {
            return ctx.response.status(404).send(fail('Tidak ada sesi kerja yang aktif'))
        }

        await closeSession(session, 'manual', 'work_end')
        await logModelEvent(ctx, {
            event: 'updated',
            subjectType: WORK_SESSION_MORPH,
            subjectId: session.id,
            organizationId: session.organization_id,
            attributes: { ended_at: laravelDate(session.ended_at), end_reason: 'manual' },
            old: { ended_at: null, end_reason: null },
        })
        await removeBroadcaster(session.organization_id, session.user_id)

        return success(
            'Selesai kerja -- siaran kamera dihentikan',
            sessionResource(withoutUserName(session))
        )
    }

    /** APK Live Kerja terbaru (tautan unduh bertanda tangan, berlaku 30 menit). */
    async app(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.broadcast')) return forbidden(ctx)

        const build = await db
            .from('apk_builds')
            .where('apk_type', 'live')
            .where('status', 'success')
            .whereNotNull('file_path')
            .orderBy('id', 'desc')
            .first()

        return success(
            'APK Live Kerja',
            build
                ? {
                      version: build.version,
                      created_at: build.created_at,
                      download_url: laravelUrlSigner.temporarySignedUrl(
                          `/api/v1/apk-builds/${build.id}/download`,
                          new Date(Date.now() + 30 * 60_000)
                      ),
                  }
                : null
        )
    }

    /** Log kerja satu site (atau semua site yang boleh ditonton) dalam satu rentang. */
    async activity(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) return forbidden(ctx)

        const input = await ctx.request.validateUsing(activityValidator)
        const from = new Date(input.from)
        const to = new Date(input.to)
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
            return ctx.response.status(422).send(
                fail('Isian tidak lolos validasi', {
                    ...(Number.isNaN(from.getTime()) ? { from: ['Tanggal tidak valid.'] } : {}),
                    ...(Number.isNaN(to.getTime()) || to <= from
                        ? { to: ['Harus tanggal setelah from.'] }
                        : {}),
                })
            )
        }

        let organizationId: number | null = null
        let siteIds: number[]
        if (input.all_sites) {
            const sites = await watchableSites(access)
            siteIds = sites.map((site) => site.id)
        } else {
            organizationId = authorizedOrganizationId(access, input.organization_id ?? null)
            if (organizationId === null) {
                return ctx.response
                    .status(403)
                    .send(fail('Anda tidak berwenang melihat log site ini'))
            }
            siteIds = [organizationId]
        }

        if ((to.getTime() - from.getTime()) / 86_400_000 > 31) {
            return ctx.response.status(422).send(fail('Rentang log maksimal 31 hari'))
        }

        const eventColumns = [
            'work_session_events.id',
            'work_session_events.organization_id',
            'work_session_events.user_id',
            'users.name as user_name',
            'work_session_events.type',
            'work_session_events.status',
            'work_session_events.occurred_at',
        ]
        const events: PresenceEvent[] = siteIds.length
            ? await db
                  .from('work_session_events')
                  .leftJoin('users', 'users.id', 'work_session_events.user_id')
                  .whereIn('work_session_events.organization_id', siteIds)
                  .whereBetween('work_session_events.occurred_at', [from, to])
                  .orderBy('work_session_events.occurred_at')
                  .orderBy('work_session_events.id')
                  .select(eventColumns)
            : []

        // Status tiap staf tepat sebelum rentang dimulai.
        const beforeRows: PresenceEvent[] = siteIds.length
            ? await db
                  .from('work_session_events')
                  .leftJoin('users', 'users.id', 'work_session_events.user_id')
                  .whereIn(
                      'work_session_events.id',
                      db
                          .from('work_session_events')
                          .whereIn('organization_id', siteIds)
                          .where('occurred_at', '<', from)
                          .groupBy('user_id')
                          .max('id')
                  )
                  .select(eventColumns)
            : []
        const before = new Map(beforeRows.map((event) => [event.user_id, event]))

        return success('Log kerja', {
            organization_id: organizationId,
            summary: summarize(events, before, from, to),
            initial_statuses: Object.fromEntries(
                beforeRows.map((event) => [event.user_id, event.status])
            ),
            events,
        })
    }

    /** Token tonton-saja untuk satu site, atau ruang leader (room=leaders). */
    async watchToken(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) return forbidden(ctx)

        if (ctx.request.input('room') === LEADERS_ROOM) {
            if (!canWatchLeaders(access)) {
                return ctx.response
                    .status(403)
                    .send(fail('Anda tidak berwenang menonton ruang leader'))
            }
            const viewer = ctx.authUser!
            return success(
                'Token tonton',
                connectionDetails(null, viewerToken(null, viewer.id, viewer.name))
            )
        }

        const organizationId = authorizedOrganizationId(access, requestedOrganizationId(ctx))
        if (organizationId === null) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang menonton site ini'))
        }

        const user = ctx.authUser!
        return success(
            'Token tonton',
            connectionDetails(organizationId, viewerToken(organizationId, user.id, user.name))
        )
    }
}

/** Sesi kerja baru + log aktivitas (LogsActivity) + kejadian work_start. */
async function createSession(
    ctx: HttpContext,
    userId: number,
    organizationId: number | null
): Promise<WorkSessionRow> {
    try {
        const now = new Date()
        const [created] = await db
            .table('work_sessions')
            .insert({
                user_id: userId,
                organization_id: organizationId,
                started_at: now,
                last_heartbeat_at: now,
                created_at: now,
                updated_at: now,
            })
            .returning('id')
        const session: WorkSessionRow = await openSessions()
            .where('work_sessions.id', created.id)
            .firstOrFail()

        await logModelEvent(ctx, {
            event: 'created',
            subjectType: WORK_SESSION_MORPH,
            subjectId: session.id,
            organizationId: session.organization_id,
            attributes: {
                organization_id: session.organization_id,
                started_at: laravelDate(session.started_at),
                ended_at: null,
                end_reason: null,
            },
        })
        await record(userId, 'work_start', session)
        return session
    } catch (error) {
        // Klik ganda / dua tab bersamaan -- partial unique index di migrasi
        // menolak sesi terbuka kedua (kode Postgres 23505).
        const existing =
            (error as { code?: string }).code === '23505' ? await openSessionOf(userId) : null
        if (!existing) throw error
        return existing
    }
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}

function requestedOrganizationId(ctx: HttpContext): number | null {
    const value = Number.parseInt(String(ctx.request.input('organization_id', '')), 10)
    return Number.isInteger(value) && value > 0 ? value : null
}

function connectionDetails(organizationId: number | null, token: string) {
    return {
        livekit_url: liveKitConfig().url,
        room: roomForSession(organizationId),
        token,
    }
}

/** Ruang leader hanya ditonton peran di atas leader: admin & root. */
function canWatchLeaders(access: Access): boolean {
    return ['super_admin', 'admin'].some((role) => hasRole(access, role))
}

/** Cache singkat jawaban overview (JSON polos, tanggal jadi string ISO). */
async function cachedOverview<T>(cacheKey: string, load: () => Promise<T>): Promise<T> {
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)
    const fresh = JSON.parse(JSON.stringify(await load()))
    await redis.setex(cacheKey, OVERVIEW_CACHE_SECONDS, JSON.stringify(fresh))
    return fresh
}

/** Semua leader aktif beserta status Live Kerja-nya (ruang leader). */
async function leaderRoster(openSessionRows: WorkSessionRow[]) {
    const sessionsByUser = new Map(openSessionRows.map((session) => [session.user_id, session]))
    const leaders = await db
        .from('users')
        .where('is_active', true)
        .whereNull('deleted_at')
        .whereIn(
            'id',
            db
                .from('model_has_roles')
                .join('roles', 'roles.id', 'model_has_roles.role_id')
                .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
                .where('roles.name', 'leader')
                .select('model_has_roles.model_id')
        )
        .orderBy('name')
        .select('id', 'name')

    const logins = await activeLoginsOf(leaders.map((leader) => leader.id))
    const now = new Date()
    return leaders.map((leader) => {
        const session = sessionsByUser.get(leader.id) ?? null
        const status = statusOf(session, now)
        return {
            user_id: leader.id,
            name: leader.name,
            organization_id: null,
            participant_identity: `user-${leader.id}`,
            status: status === 'offline' && logins.has(leader.id) ? 'online' : status,
            started_at: session?.started_at ?? null,
            login_device: logins.get(leader.id) ?? null,
        }
    })
}

/** WorkSessionResource tanpa relasi user dimuat tidak punya kunci user_name. */
function withoutUserName(session: WorkSessionRow): WorkSessionRow {
    const rest = { ...session }
    delete rest.user_name
    return rest
}

async function openSessionsIn(organizationIds: number[]): Promise<WorkSessionRow[]> {
    if (!organizationIds.length) return []
    return openSessions()
        .whereIn('work_sessions.organization_id', organizationIds)
        .orderBy('work_sessions.started_at')
}

/** Site aktif yang boleh ditonton user ini, dengan jumlah staf yang sedang live. */
async function watchableSites(
    access: Access
): Promise<Array<{ id: number; name: string; live_count: number }>> {
    const query = db
        .from('organizations')
        .where('is_active', true)
        .whereNull('deleted_at')
        .select('id', 'name')
        .select(
            db.raw(
                '(select count(*) from work_sessions where work_sessions.organization_id = organizations.id and work_sessions.ended_at is null)::int as live_count'
            )
        )
        .orderBy('name')

    if (!hasCrossOrganizationAccess(access)) {
        query.whereIn(
            'id',
            hasGrantBasedAccess(access)
                ? access.grantedOrganizationIds
                : access.organizationId === null
                  ? []
                  : [access.organizationId]
        )
    }

    return query
}

/** Semua staf (yang boleh Live Kerja) di site-site ini beserta statusnya. */
async function rosterFor(organizationIds: number[], openSessionRows: WorkSessionRow[]) {
    if (!organizationIds.length) return []

    const sessionsByUser = new Map(openSessionRows.map((session) => [session.user_id, session]))

    // Padanan User::permission('live.broadcast'): izin langsung atau lewat peran.
    const permissionId = db.from('permissions').where('name', 'live.broadcast').select('id')
    const staff = await db
        .from('users')
        .whereIn('organization_id', organizationIds)
        .where('is_active', true)
        .whereNull('deleted_at')
        .where((query) => {
            query
                .whereIn(
                    'id',
                    db
                        .from('model_has_permissions')
                        .where('model_type', LARAVEL_USER_MORPH)
                        .whereIn('permission_id', permissionId)
                        .select('model_id')
                )
                .orWhereIn(
                    'id',
                    db
                        .from('model_has_roles')
                        .join(
                            'role_has_permissions',
                            'role_has_permissions.role_id',
                            'model_has_roles.role_id'
                        )
                        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
                        .whereIn('role_has_permissions.permission_id', permissionId)
                        .select('model_has_roles.model_id')
                )
        })
        .orderBy('name')
        .select('id', 'name', 'organization_id')

    const logins = await activeLoginsOf(staff.map((member) => member.id))
    const now = new Date()

    return staff.map((member) => {
        const session = sessionsByUser.get(member.id) ?? null
        const status = statusOf(session, now)
        return {
            user_id: member.id,
            name: member.name,
            organization_id: member.organization_id,
            participant_identity: `user-${member.id}`,
            // Login tapi belum Mulai kerja = 'online', bukan 'offline'. Hanya
            // tampilan roster -- log & jam kerja tetap memakai statusOf().
            status: status === 'offline' && logins.has(member.id) ? 'online' : status,
            started_at: session?.started_at ?? null,
            login_device: logins.get(member.id) ?? null,
        }
    })
}

/**
 * User yang masih punya token login berlaku -> perangkatnya ('computer' |
 * 'phone' | null untuk token lama sebelum kolom device_type). Token login
 * selalu punya expires_at (idle timeout 2 jam); token akun layanan tidak.
 */
async function activeLoginsOf(userIds: number[]): Promise<Map<number, string | null>> {
    if (!userIds.length) return new Map()
    const rows = await db
        .from('personal_access_tokens')
        .where('tokenable_type', LARAVEL_USER_MORPH)
        .whereIn('tokenable_id', userIds)
        .where('expires_at', '>', new Date())
        .orderBy('id')
        .select('tokenable_id', 'device_type')

    const logins = new Map<number, string | null>()
    for (const row of rows) {
        const userId = Number(row.tokenable_id)
        logins.set(userId, row.device_type ?? logins.get(userId) ?? null)
    }
    return logins
}
