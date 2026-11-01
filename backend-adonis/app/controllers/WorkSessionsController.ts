import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import vine from '@vinejs/vine'
import {
    accessOf,
    can,
    canWatchCentral,
    canWatchRole,
    seesOnlySelf,
    type Access,
} from '#services/Access'
import { fail, success } from '#services/ApiResponse'
import { laravelDate, logModelEvent, WORK_SESSION_MORPH } from '#services/ActivityLog'
import { laravelUrlSigner, LARAVEL_USER_MORPH } from '#services/laravel/index'
import {
    broadcasterToken,
    liveKitConfig,
    removeBroadcaster,
    roomName,
    roomOfSession,
    UNKNOWN_LIVE_ROLE,
    viewerToken,
    type LiveRoom,
} from '#services/Livekit'
import { liveRolesOf } from '#services/Permissions'
import { ROLE_NAME_PATTERN } from '#services/RoleRules'
import {
    authorizedOrganizationId,
    hasCrossOrganizationAccess,
    hasGrantBasedAccess,
} from '#services/OrganizationScope'
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
} from '#services/WorkPresence'
import { leaveToday } from '#controllers/LeaveRequestsController'

/** Umur cache GET /live/overview per kumpulan site, sama dengan backend-api. */
const OVERVIEW_CACHE_SECONDS = 5

/** Perangkat yang bisa membagikan layar + kamera saat Mulai kerja. */
const LIVE_START_DEVICES = ['computer', 'android_app']
/** iPhone/iPad (Safari & PWA): kamera saja, karena iOS tidak mengizinkan berbagi layar dari browser. */
const CAMERA_ONLY_DEVICE = 'ios_camera'
const IOS_USER_AGENT = /iPhone|iPad|iPod/i

const heartbeatValidator = vine.compile(
    vine.object({
        camera_active: vine.boolean().optional(),
        screen_active: vine.boolean().optional(),
        on_break: vine.boolean().optional(),
        idle: vine.boolean().optional(),
        face_missing: vine.boolean().optional(),
    })
)

const endValidator = vine.compile(
    vine.object({
        // Catatan kerja hari ini (opsional), ditulis saat Selesai kerja.
        note: vine.string().trim().maxLength(2000).nullable().optional(),
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
        // untuk semua yang menonton kumpulan site yang sama. Hak tonton per
        // peran disaring SETELAH cache, karena cache dipakai bersama.
        const live = await cachedOverview(`live:overview:${siteIds.join(',')}`, async () => {
            const sessions = await openSessionsIn(siteIds)
            return {
                items: sessions.map((session) => sessionResource(session)),
                roster: await rosterFor(siteIds, sessions),
            }
        })

        // Ruang pusat (penyiar tanpa site): hanya pemegang izin live.watch-central.
        const central = canWatchCentral(access)
            ? await cachedOverview('live:overview:central', async () => {
                  const sessions: WorkSessionRow[] = await openSessions()
                      .whereNull('work_sessions.organization_id')
                      .orderBy('work_sessions.started_at')
                  return {
                      items: sessions.map((session) => sessionResource(session)),
                      roster: await centralRoster(sessions),
                  }
              })
            : null

        const visible = onlySelfIfStaff(access, byWatchRoles(access, live))
        const visibleCentral =
            central && !seesOnlySelf(access) ? byWatchRoles(access, central) : null

        return success('Semua staf yang sedang live', {
            sites,
            ...visible,
            central: visibleCentral,
            // Room yang sedang berisi siaran dan boleh ditonton (site + peran).
            rooms: seesOnlySelf(access)
                ? []
                : liveRoomsOf([...visible.items, ...(visibleCentral?.items ?? [])]),
            roles: await roleOptions(),
        })
    }

    /** Staf live di satu site, status semua staf site itu, dan sesi milik user ini. */
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const canWatch = can(access, 'live.watch')
        if (!canWatch && !can(access, 'live.broadcast')) return forbidden(ctx)

        // Penyiar tanpa izin tonton, atau tanpa site (Ruang pusat): cukup sesi
        // kerjanya sendiri, untuk melanjutkan siaran setelah reload.
        if (
            !canWatch ||
            (requestedOrganizationId(ctx) === null && access.organizationId === null)
        ) {
            const mine = await openSessionOf(access.userId)
            return success('Staf yang sedang live', {
                organization_id: null,
                items: [],
                roster: [],
                my_session: mine ? sessionResource(withoutUserName(mine)) : null,
            })
        }

        const requested = requestedOrganizationId(ctx)
        const organizationId = authorizedOrganizationId(access, requested)
        if (organizationId === null) {
            // Penyiar yang site rumahnya di luar cakupan tontonnya (mis. peran "site yang diberikan"
            // yang site rumahnya tidak termasuk): tetap dapat sesinya sendiri untuk melanjutkan siaran.
            if (
                requested !== null &&
                requested === access.organizationId &&
                can(access, 'live.broadcast')
            ) {
                const own = await openSessionOf(access.userId)
                return success('Staf yang sedang live', {
                    organization_id: null,
                    items: [],
                    roster: [],
                    my_session: own ? sessionResource(withoutUserName(own)) : null,
                })
            }
            return ctx.response.status(403).send(fail('Pilih site yang boleh Anda tonton'))
        }

        const sessions = await openSessionsIn([organizationId])
        const mine = await openSessionOf(access.userId)

        return success('Staf yang sedang live', {
            organization_id: organizationId,
            ...onlySelfIfStaff(
                access,
                byWatchRoles(access, {
                    items: sessions.map((session) => sessionResource(session)),
                    roster: await rosterFor([organizationId], sessions),
                })
            ),
            my_session: mine ? sessionResource(withoutUserName(mine)) : null,
        })
    }

    async start(ctx: HttpContext) {
        const access = await accessOf(ctx)
        // Semua peran bisa Live asal memegang izin live.broadcast. Penyiar
        // ber-site masuk room site-nya; yang tidak terikat site masuk Ruang
        // pusat (organization_id NULL). Tidak ada parameter site dari client.
        if (!can(access, 'live.broadcast')) return forbidden(ctx)

        const user = ctx.authUser!

        // Layar & kamera wajib: dashboard di komputer, atau APK Live Kerja
        // versi berbagi layar ('android_app'). Pengecualian: iPhone/iPad (kamera saja) --
        // hanya dari browser iOS, dan sesinya ditandai camera_only supaya terlihat atasan.
        const device = ctx.request.input('device')
        const cameraOnly =
            device === CAMERA_ONLY_DEVICE &&
            IOS_USER_AGENT.test(ctx.request.header('user-agent') ?? '')
        if (device === CAMERA_ONLY_DEVICE && !cameraOnly) {
            return ctx.response
                .status(422)
                .send(
                    fail(
                        'Siaran kamera saja hanya untuk iPhone/iPad. Di komputer, bagikan layar & kamera.'
                    )
                )
        }
        if (!cameraOnly && !LIVE_START_DEVICES.includes(device)) {
            return ctx.response
                .status(422)
                .send(
                    fail(
                        'Live Kerja hanya bisa dimulai dari komputer (Chrome atau Edge): layar & kamera wajib dibagikan.'
                    )
                )
        }

        const liveRoles = await liveRolesOf([user.id])
        const liveRole = liveRoles.get(user.id) ?? UNKNOWN_LIVE_ROLE
        const session =
            (await openSessionOf(user.id)) ??
            (await createSession(ctx, user.id, user.organizationId, liveRole))
        // Sesi dilanjutkan dari perangkat lain (mis. iPhone lalu komputer): tandai ulang sesuai perangkatnya.
        if ((session.camera_only === true) !== cameraOnly) {
            await db
                .from('work_sessions')
                .where('id', session.id)
                .update({ camera_only: cameraOnly })
            session.camera_only = cameraOnly
        }

        // Sesi lama dilanjutkan memakai site & peran yang tercatat di sesi.
        const room = roomOfSession(session)
        return ctx.response.status(201).send(
            success('Mulai kerja -- siaran kamera aktif', {
                session: sessionResource(withoutUserName(session)),
                ...connectionDetails(
                    room,
                    broadcasterToken(room, user.id, user.name, {
                        // Rekan se-room ikut terlihat hanya kalau penyiar boleh menontonnya.
                        canSubscribe:
                            !seesOnlySelf(access) &&
                            canWatchRole(access, room.role) &&
                            (room.organizationId !== null || canWatchCentral(access)),
                    })
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
        const { note } = await ctx.request.validateUsing(endValidator)
        const session = await openSessionOf(ctx.authUser!.id)
        if (!session) {
            return ctx.response.status(404).send(fail('Tidak ada sesi kerja yang aktif'))
        }

        if (note) {
            await db.from('work_sessions').where('id', session.id).update({ end_note: note })
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
        await removeBroadcaster(roomOfSession(session), session.user_id)

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

        // Staf biasa hanya melihat log kerjanya sendiri.
        const ownOnly = seesOnlySelf(access) ? access.userId : null
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
                  .if(ownOnly !== null, (query) =>
                      query.where('work_session_events.user_id', ownOnly!)
                  )
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
                          .if(ownOnly !== null, (query) => query.where('user_id', ownOnly!))
                          .where('occurred_at', '<', from)
                          .groupBy('user_id')
                          .max('id')
                  )
                  .select(eventColumns)
            : []
        const before = new Map(beforeRows.map((event) => [event.user_id, event]))

        // Catatan kerja yang ditulis saat Selesai kerja dalam rentang ini.
        const notes = siteIds.length
            ? await db
                  .from('work_sessions')
                  .whereIn('organization_id', siteIds)
                  .if(ownOnly !== null, (query) => query.where('user_id', ownOnly!))
                  .whereNotNull('end_note')
                  .whereBetween('ended_at', [from, to])
                  .orderBy('ended_at')
                  .select(
                      'id as session_id',
                      'user_id',
                      'started_at',
                      'ended_at',
                      'end_note as note'
                  )
            : []

        return success('Log kerja', {
            notes,
            organization_id: organizationId,
            summary: summarize(events, before, from, to),
            initial_statuses: Object.fromEntries(
                beforeRows.map((event) => [event.user_id, event.status])
            ),
            events,
        })
    }

    /**
     * Token tonton-saja untuk satu room: site + peran penyiar, atau Ruang
     * pusat (central=true) + peran. Room hanya dibuka kalau site boleh
     * diakses DAN peran itu termasuk hak tonton peran user ini.
     */
    async watchToken(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) return forbidden(ctx)
        if (seesOnlySelf(access)) {
            return ctx.response.status(403).send(fail('Staf hanya bisa melihat siarannya sendiri'))
        }

        const role = String(ctx.request.input('role') ?? '')
        if (!ROLE_NAME_PATTERN.test(role) && role !== UNKNOWN_LIVE_ROLE) {
            return ctx.response.status(422).send(
                fail('Data yang diberikan tidak valid.', {
                    role: ['Pilih peran siaran yang akan ditonton.'],
                })
            )
        }
        if (!canWatchRole(access, role)) {
            return ctx.response
                .status(403)
                .send(fail('Peran Anda tidak diizinkan menonton siaran peran ini'))
        }

        const viewer = ctx.authUser!
        const central = [true, 'true', '1', 1].includes(ctx.request.input('central'))
        if (central) {
            if (!canWatchCentral(access)) {
                return ctx.response
                    .status(403)
                    .send(fail('Anda tidak berwenang menonton Ruang pusat'))
            }
            const room = { organizationId: null, role }
            return success(
                'Token tonton',
                connectionDetails(room, viewerToken(room, viewer.id, viewer.name))
            )
        }

        const requested = requestedOrganizationId(ctx)
        // Tanpa site yang diminta: itu kesalahan permintaan, bukan soal hak (Super Admin pun harus menyebut site).
        if (requested === null && hasCrossOrganizationAccess(access)) {
            return ctx.response.status(422).send(
                fail('Data yang diberikan tidak valid.', {
                    organization_id: ['Pilih site yang akan ditonton.'],
                })
            )
        }
        const organizationId = authorizedOrganizationId(access, requested)
        if (organizationId === null) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang menonton site ini'))
        }

        const room = { organizationId, role }
        return success(
            'Token tonton',
            connectionDetails(room, viewerToken(room, viewer.id, viewer.name))
        )
    }
}

/** Sesi kerja baru + log aktivitas (LogsActivity) + kejadian work_start. */
async function createSession(
    ctx: HttpContext,
    userId: number,
    organizationId: number | null,
    liveRole: string
): Promise<WorkSessionRow> {
    try {
        const now = new Date()
        const [created] = await db
            .table('work_sessions')
            .insert({
                user_id: userId,
                organization_id: organizationId,
                live_role: liveRole,
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

function connectionDetails(room: LiveRoom, token: string) {
    return {
        livekit_url: liveKitConfig().url,
        room: roomName(room),
        token,
    }
}

/** Hak tonton per peran: buang siaran & status penyiar dari peran yang tidak boleh ditonton. */
function byWatchRoles<
    T extends { live_role?: string | null },
    R extends { live_role?: string | null },
>(access: Access, live: { items: T[]; roster: R[] }): { items: T[]; roster: R[] } {
    const allowed = (role: string | null | undefined) =>
        canWatchRole(access, role ?? UNKNOWN_LIVE_ROLE)
    return {
        items: live.items.filter((item) => allowed(item.live_role)),
        roster: live.roster.filter((member) => allowed(member.live_role)),
    }
}

/** Room (site/pusat + peran) yang sedang berisi siaran, dari daftar sesi yang boleh ditonton. */
function liveRoomsOf(items: Array<{ organization_id: number | null; live_role?: string | null }>) {
    const rooms = new Map<
        string,
        { organization_id: number | null; role: string; live_count: number }
    >()
    for (const item of items) {
        const role = item.live_role ?? UNKNOWN_LIVE_ROLE
        const key = `${item.organization_id ?? 'pusat'}:${role}`
        const room = rooms.get(key) ?? {
            organization_id: item.organization_id,
            role,
            live_count: 0,
        }
        room.live_count++
        rooms.set(key, room)
    }
    return [...rooms.values()]
}

/** Nama & label semua peran, untuk mengelompokkan siaran per peran di dashboard. */
async function roleOptions(): Promise<Array<{ name: string; label: string }>> {
    const rows = await db
        .from('roles')
        .where('guard_name', 'web')
        .whereNot('name', 'telegram_bot_service')
        .orderBy('id')
        .select('name', 'label')
    return rows.map((row) => ({ name: row.name, label: row.label ?? row.name }))
}

/** Staf biasa: daftar siaran & status hanya berisi dirinya sendiri. */
function onlySelfIfStaff<T extends { user_id: number }, R extends { user_id: number }>(
    access: Access,
    live: { items: T[]; roster: R[] }
): { items: T[]; roster: R[] } {
    if (!seesOnlySelf(access)) return live
    return {
        items: live.items.filter((item) => item.user_id === access.userId),
        roster: live.roster.filter((member) => member.user_id === access.userId),
    }
}

/** Cache singkat jawaban overview (JSON polos, tanggal jadi string ISO). */
async function cachedOverview<T>(cacheKey: string, load: () => Promise<T>): Promise<T> {
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)
    const fresh = JSON.parse(JSON.stringify(await load()))
    await redis.setex(cacheKey, OVERVIEW_CACHE_SECONDS, JSON.stringify(fresh))
    return fresh
}

/**
 * Ruang pusat: semua penyiar aktif yang tidak terikat site (mis. leader),
 * beserta status Live Kerja-nya, plus yang sedang siaran di sana.
 */
async function centralRoster(openSessionRows: WorkSessionRow[]) {
    const sessionsByUser = new Map(openSessionRows.map((session) => [session.user_id, session]))
    const members = await broadcasters()
        .where((query) =>
            query.whereNull('organization_id').orWhereIn('id', [...sessionsByUser.keys()])
        )
        .orderBy('name')
        .select('id', 'name')

    const ids = members.map((member) => member.id)
    const [logins, liveRoles] = await Promise.all([activeLoginsOf(ids), liveRolesOf(ids)])
    const now = new Date()
    return members.map((member) => {
        const session = sessionsByUser.get(member.id) ?? null
        const status = statusOf(session, now)
        return {
            user_id: member.id,
            name: member.name,
            organization_id: null,
            live_role: session
                ? (session.live_role ?? UNKNOWN_LIVE_ROLE)
                : (liveRoles.get(member.id) ?? UNKNOWN_LIVE_ROLE),
            participant_identity: `user-${member.id}`,
            status: status === 'offline' && logins.has(member.id) ? 'online' : status,
            started_at: session?.started_at ?? null,
            login_device: logins.get(member.id) ?? null,
        }
    })
}

/** User aktif yang boleh Live Kerja: izin live.broadcast langsung atau lewat peran. */
function broadcasters() {
    // Padanan User::permission('live.broadcast').
    const permissionId = db.from('permissions').where('name', 'live.broadcast').select('id')
    return db
        .from('users')
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

/**
 * Site aktif yang boleh ditonton user ini, dengan jumlah siaran yang boleh ia
 * tonton (hak tonton per peran ikut dihitung).
 */
async function watchableSites(
    access: Access
): Promise<Array<{ id: number; name: string; live_count: number }>> {
    const roles = access.watchRoles
    const liveCount = db
        .from('work_sessions')
        .whereColumn('work_sessions.organization_id', 'organizations.id')
        .whereNull('work_sessions.ended_at')
        .if(Array.isArray(roles), (count) => count.whereIn('work_sessions.live_role', roles!))
        .count('*')
        .as('live_count')
    const query = db
        .from('organizations')
        .where('is_active', true)
        .whereNull('deleted_at')
        .select('id', 'name')
        .select(liveCount)
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

    // count(*) Postgres = bigint (string di driver pg).
    const rows = await query
    return rows.map((row) => ({ id: row.id, name: row.name, live_count: Number(row.live_count) }))
}

/** Semua staf (yang boleh Live Kerja) di site-site ini beserta statusnya. */
async function rosterFor(organizationIds: number[], openSessionRows: WorkSessionRow[]) {
    if (!organizationIds.length) return []

    const sessionsByUser = new Map(openSessionRows.map((session) => [session.user_id, session]))

    const staff = await broadcasters()
        .whereIn('organization_id', organizationIds)
        .orderBy('name')
        .select('id', 'name', 'organization_id')

    const ids = staff.map((member) => member.id)
    const [logins, leaves, liveRoles] = await Promise.all([
        activeLoginsOf(ids),
        leaveToday(ids),
        liveRolesOf(ids),
    ])
    const now = new Date()

    return staff.map((member) => {
        const session = sessionsByUser.get(member.id) ?? null
        const status = statusOf(session, now)
        return {
            user_id: member.id,
            name: member.name,
            organization_id: member.organization_id,
            // Peran tempat siarannya dicatat (sesi berjalan), atau peran pertamanya.
            live_role: session
                ? (session.live_role ?? UNKNOWN_LIVE_ROLE)
                : (liveRoles.get(member.id) ?? UNKNOWN_LIVE_ROLE),
            participant_identity: `user-${member.id}`,
            // Login tapi belum Mulai kerja = 'online', bukan 'offline'. Hanya
            // tampilan roster -- log & jam kerja tetap memakai statusOf().
            status: status === 'offline' && logins.has(member.id) ? 'online' : status,
            started_at: session?.started_at ?? null,
            face_missing: session?.face_missing ?? false,
            login_device: logins.get(member.id) ?? null,
            // Izin/sakit/cuti yang disetujui untuk hari ini.
            leave: leaves.get(member.id) ?? null,
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
