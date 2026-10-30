import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'
import { accessOf } from '#services/access'
import { writeActivity } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import {
    BRIEFING_AUDIENCE_ROLES,
    briefingToken,
    canHostBriefing,
    canJoinBriefing,
    roomForBriefing,
    sitesOf,
    type BriefingRow,
} from '#services/briefing'
import {
    asBriefing,
    finishBriefing,
    nextRunAt,
    pingBriefingPresence,
    PRESENCE_TIMEOUT_SECONDS,
    RECURRENCES,
    type ScheduleRow,
} from '#services/briefing_schedule'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { liveKitConfig } from '#services/livekit'
import { colleaguesOf as inviteCandidates } from '#services/people'
import { DATE_PATTERN, localDate, TIME_PATTERN } from '#services/local_time'

const AUDIENCE_KEYS = Object.keys(BRIEFING_AUDIENCE_ROLES) as Array<
    keyof typeof BRIEFING_AUDIENCE_ROLES
>

const startValidator = vine.compile(
    vine.object({
        title: vine.string().trim().minLength(1).maxLength(120),
        roles: vine.array(vine.enum(AUDIENCE_KEYS)).optional(),
        organization_ids: vine.array(vine.number().withoutDecimals().positive()).optional(),
        // Peserta pilihan: kalau diisi, hanya user ini (plus pemimpin) yang bisa bergabung.
        user_ids: vine.array(vine.number().withoutDecimals().positive()).maxLength(100).optional(),
        // Diisi = jadwalkan, tidak langsung dimulai.
        schedule: vine
            .object({
                date: vine.string().regex(DATE_PATTERN),
                time: vine.string().regex(TIME_PATTERN),
                recurrence: vine.enum(Object.keys(RECURRENCES) as Array<keyof typeof RECURRENCES>),
                duration_minutes: vine.number().withoutDecimals().min(5).max(480),
            })
            .optional(),
    })
)

/** Riwayat briefing yang ditampilkan ke pemimpin. */
const HISTORY_DAYS = 14

/**
 * Briefing: rapat video Live dalam satu ruang. Pemimpin (leader, admin, root)
 * memilih peran & site yang boleh bergabung, atau langsung memilih orangnya
 * -- lihat app/services/briefing.ts.
 */
export default class BriefingsController {
    /** Briefing yang sedang berlangsung & boleh diikuti user ini, plus pilihan untuk memulai. */
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const active: BriefingRow[] = await db
            .from('briefings')
            .whereNull('ended_at')
            .orderBy('started_at', 'desc')
        const joinable = active.filter((briefing) => canJoinBriefing(access, briefing))

        const canHost = canHostBriefing(access)
        const hostSites = canHost ? await sitesFor(access) : []
        // Daftar calon peserta hanya untuk halaman Briefing (banner di semua halaman tidak perlu).
        const people =
            canHost && ctx.request.input('with_people') ? await inviteCandidates(access) : []
        const names = await userNames(
            joinable.flatMap((briefing) => [briefing.host_user_id, ...invitedOf(briefing)])
        )
        const siteNames = await organizationNames(
            joinable.flatMap((b) => b.allowed_organization_ids)
        )

        // Jadwal mendatang yang mengundang user ini (atau dibuat olehnya).
        const schedules: ScheduleRow[] = await db
            .from('briefing_schedules')
            .where('is_active', true)
            .whereNotNull('next_run_at')
            .orderBy('next_run_at')
        const upcoming = schedules.filter(
            (schedule) =>
                schedule.host_user_id === access.userId ||
                canJoinBriefing(access, asBriefing(schedule))
        )
        const recent = canHost
            ? await db
                  .from('briefings')
                  .whereNotNull('ended_at')
                  .where('started_at', '>=', new Date(Date.now() - HISTORY_DAYS * 86_400_000))
                  .if(!access.roles.includes('super_admin'), (query) =>
                      query.where('host_user_id', access.userId)
                  )
                  .orderBy('started_at', 'desc')
                  .limit(20)
                  .select(
                      'id',
                      'title',
                      'host_user_id',
                      'started_at',
                      'ended_at',
                      db.raw(
                          '(select count(distinct user_id) from briefing_attendances where briefing_attendances.briefing_id = briefings.id and briefing_attendances.user_id <> briefings.host_user_id)::int as attendee_count'
                      )
                  )
            : []
        const extraNames = await userNames([
            ...upcoming.flatMap((schedule) => [
                schedule.host_user_id,
                ...schedule.invited_user_ids,
            ]),
            ...recent.map((briefing) => briefing.host_user_id),
        ])
        const scheduleSites = await organizationNames(
            upcoming.flatMap((schedule) => schedule.allowed_organization_ids)
        )

        return success('Briefing', {
            can_host: canHost,
            recurrences: Object.entries(RECURRENCES).map(([value, label]) => ({ value, label })),
            upcoming: upcoming.map((schedule) => ({
                id: schedule.id,
                title: schedule.title,
                next_run_at: schedule.next_run_at,
                recurrence: schedule.recurrence,
                recurrence_label: RECURRENCES[schedule.recurrence],
                duration_minutes: schedule.duration_minutes,
                host_name: extraNames.get(schedule.host_user_id) ?? null,
                is_host: schedule.host_user_id === access.userId,
                can_cancel:
                    schedule.host_user_id === access.userId || access.roles.includes('super_admin'),
                roles: schedule.allowed_roles,
                sites: schedule.allowed_organization_ids.map(
                    (id) => scheduleSites.get(id) ?? `Site ${id}`
                ),
                invited: schedule.invited_user_ids.map((id) => extraNames.get(id) ?? `User ${id}`),
            })),
            recent: recent.map((briefing) => ({
                id: briefing.id,
                title: briefing.title,
                host_name: extraNames.get(briefing.host_user_id) ?? null,
                started_at: briefing.started_at,
                ended_at: briefing.ended_at,
                attendee_count: briefing.attendee_count,
            })),
            roles: AUDIENCE_KEYS.map((value) => ({ value, label: BRIEFING_AUDIENCE_ROLES[value] })),
            sites: hostSites,
            people,
            items: joinable.map((briefing) => ({
                id: briefing.id,
                title: briefing.title,
                host_name: names.get(briefing.host_user_id) ?? null,
                is_host: briefing.host_user_id === access.userId,
                roles: briefing.allowed_roles,
                sites: briefing.allowed_organization_ids.map(
                    (id) => siteNames.get(id) ?? `Site ${id}`
                ),
                invited: invitedOf(briefing).map((id) => names.get(id) ?? `User ${id}`),
                started_at: briefing.started_at,
                scheduled: briefing.schedule_id !== null && briefing.schedule_id !== undefined,
                planned_end_at: briefing.planned_end_at ?? null,
            })),
        })
    }

    /** Mulai briefing baru; pemimpin langsung mendapat token bergabung. */
    async store(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!canHostBriefing(access)) {
            return ctx.response
                .status(403)
                .send(fail('Hanya leader, admin, atau root yang bisa memulai briefing'))
        }
        const input = await ctx.request.validateUsing(startValidator)
        const roles = [...new Set(input.roles ?? [])]
        const invitedIds = [...new Set(input.user_ids ?? [])].filter((id) => id !== access.userId)

        if (invitedIds.length) {
            // Hanya orang di site yang dipegang pemimpin (root: semua).
            const candidates = await inviteCandidates(access)
            const allowed = new Set(candidates.map((person) => person.id))
            if (invitedIds.some((id) => !allowed.has(id))) {
                return ctx.response
                    .status(403)
                    .send(fail('Ada peserta yang tidak berada di site yang Anda pegang'))
            }
        } else if (!roles.length) {
            return ctx.response
                .status(422)
                .send(fail('Pilih minimal satu peran atau satu peserta untuk diundang'))
        }

        // Site yang diundang harus site yang dipegang pemimpin; kosong = semua
        // site miliknya (root: benar-benar semua site).
        const own = sitesOf(access)
        let siteIds = invitedIds.length ? [] : [...new Set(input.organization_ids ?? [])]
        if (own !== 'all' && !invitedIds.length) {
            if (siteIds.some((id) => !own.includes(id))) {
                return ctx.response.status(403).send(fail('Ada site yang tidak Anda pegang'))
            }
            if (!siteIds.length) siteIds = own
            // Daftar kosong berarti "semua site" (lihat canJoinBriefing) --
            // pemimpin tanpa site tidak boleh jatuh ke sana.
            if (!siteIds.length) {
                return ctx.response
                    .status(403)
                    .send(fail('Anda belum memegang site mana pun untuk diundang briefing'))
            }
        }

        const now = new Date()
        if (input.schedule) {
            const plan = input.schedule
            if (plan.recurrence === 'once' && plan.date < localDate(now)) {
                return ctx.response.status(422).send(fail('Tanggal jadwal sudah lewat'))
            }
            const first = nextRunAt(
                { recurrence: plan.recurrence, start_date: plan.date, start_time: plan.time },
                now
            )
            if (!first) {
                return ctx.response
                    .status(422)
                    .send(fail('Waktu jadwal sudah lewat. Pilih tanggal & jam yang akan datang.'))
            }
            const [schedule] = await db
                .table('briefing_schedules')
                .insert({
                    title: input.title,
                    host_user_id: access.userId,
                    allowed_roles: JSON.stringify(invitedIds.length ? [] : roles),
                    allowed_organization_ids: JSON.stringify(siteIds),
                    invited_user_ids: JSON.stringify(invitedIds),
                    recurrence: plan.recurrence,
                    start_date: plan.date,
                    start_time: plan.time,
                    duration_minutes: plan.duration_minutes,
                    next_run_at: first,
                    is_active: true,
                    created_at: now,
                    updated_at: now,
                })
                .returning(['id', 'title', 'next_run_at'])
            await writeActivity(ctx, {
                logName: 'briefings',
                description: `Menjadwalkan briefing "${input.title}" (${RECURRENCES[plan.recurrence]}, ${plan.date} ${plan.time})`,
                event: 'created',
                subjectType: null,
                subjectId: schedule.id,
                properties: { roles, organization_ids: siteIds, user_ids: invitedIds, ...plan },
                organizationId: siteIds.length === 1 ? siteIds[0] : null,
            })
            return ctx.response.status(201).send(success('Briefing dijadwalkan', { schedule }))
        }

        const [row] = await db
            .table('briefings')
            .insert({
                title: input.title,
                host_user_id: access.userId,
                allowed_roles: JSON.stringify(invitedIds.length ? [] : roles),
                allowed_organization_ids: JSON.stringify(siteIds),
                invited_user_ids: JSON.stringify(invitedIds),
                started_at: now,
                created_at: now,
                updated_at: now,
            })
            .returning('*')
        const briefing = row as BriefingRow

        await writeActivity(ctx, {
            logName: 'briefings',
            description: `Memulai briefing "${briefing.title}"`,
            event: 'created',
            subjectType: null,
            subjectId: briefing.id,
            properties: {
                roles: briefing.allowed_roles,
                organization_ids: briefing.allowed_organization_ids,
                user_ids: invitedOf(briefing),
            },
            organizationId: siteIds.length === 1 ? siteIds[0] : null,
        })

        return ctx.response
            .status(201)
            .send(success('Briefing dimulai', connection(briefing, ctx, true)))
    }

    /** Token bergabung ke briefing yang masih berlangsung. */
    async join(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const briefing = await findBriefing(ctx.params.id)
        if (!briefing || briefing.ended_at) {
            return ctx.response
                .status(404)
                .send(fail('Briefing sudah selesai atau tidak ditemukan'))
        }
        if (!canJoinBriefing(access, briefing)) {
            return ctx.response
                .status(403)
                .send(fail('Briefing ini tidak untuk peran atau site Anda'))
        }
        return success(
            'Bergabung ke briefing',
            connection(briefing, ctx, briefing.host_user_id === access.userId)
        )
    }

    /** Akhiri briefing untuk semua peserta (pemimpin atau root). */
    async end(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const briefing = await findBriefing(ctx.params.id)
        if (!briefing) return ctx.response.status(404).send(fail('Briefing tidak ditemukan'))
        if (briefing.host_user_id !== access.userId && !access.roles.includes('super_admin')) {
            return ctx.response
                .status(403)
                .send(fail('Hanya pemimpin briefing yang bisa mengakhirinya'))
        }

        if (!briefing.ended_at) {
            await finishBriefing(briefing.id)
            await writeActivity(ctx, {
                logName: 'briefings',
                description: `Mengakhiri briefing "${briefing.title}"`,
                event: 'updated',
                subjectType: null,
                subjectId: briefing.id,
                properties: {},
                organizationId: null,
            })
        }
        return success('Briefing diakhiri')
    }

    /** Detak kehadiran selama peserta berada di ruang briefing (daftar hadir). */
    async presence(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const briefing = await findBriefing(ctx.params.id)
        if (!briefing || briefing.ended_at) {
            return ctx.response
                .status(404)
                .send(fail('Briefing sudah selesai atau tidak ditemukan'))
        }
        if (!canJoinBriefing(access, briefing)) {
            return ctx.response
                .status(403)
                .send(fail('Briefing ini tidak untuk peran atau site Anda'))
        }
        await pingBriefingPresence(briefing.id, access.userId)
        return success('Kehadiran tercatat')
    }

    /** Daftar hadir: siapa yang ikut, berapa lama, dan siapa yang diundang tapi tidak hadir. */
    async attendance(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const briefing = await findBriefing(ctx.params.id)
        if (!briefing) return ctx.response.status(404).send(fail('Briefing tidak ditemukan'))
        if (briefing.host_user_id !== access.userId && !access.roles.includes('super_admin')) {
            return ctx.response
                .status(403)
                .send(fail('Hanya pemimpin briefing yang bisa melihat daftar hadirnya'))
        }

        const rows = await db
            .from('briefing_attendances')
            .where('briefing_id', briefing.id)
            .orderBy('joined_at')
        const now = Date.now()
        const end = briefing.ended_at ? briefing.ended_at.getTime() : now
        const byUser = new Map<
            number,
            { first_joined_at: Date; last_seen_at: Date; seconds: number; visits: number }
        >()
        for (const row of rows) {
            const userId = Number(row.user_id)
            const until = Math.min(row.last_seen_at.getTime(), end)
            const seconds = Math.max(0, Math.round((until - row.joined_at.getTime()) / 1000))
            const entry = byUser.get(userId)
            if (entry) {
                entry.seconds += seconds
                entry.visits++
                if (row.last_seen_at > entry.last_seen_at) entry.last_seen_at = row.last_seen_at
            } else {
                byUser.set(userId, {
                    first_joined_at: row.joined_at,
                    last_seen_at: row.last_seen_at,
                    seconds,
                    visits: 1,
                })
            }
        }

        const invitees = await expectedAttendees(briefing)
        const expected = invitees.filter((person) => person.id !== briefing.host_user_id)
        const names = await userNames([
            briefing.host_user_id,
            ...byUser.keys(),
            ...expected.map((person) => person.id),
        ])
        const expectedById = new Map(expected.map((person) => [person.id, person]))
        // Lewat 5 menit dari mulainya briefing = terlambat.
        const lateAfter = briefing.started_at.getTime() + 5 * 60_000
        const inside = (lastSeen: Date) =>
            !briefing.ended_at && now - lastSeen.getTime() <= PRESENCE_TIMEOUT_SECONDS * 1000

        const attended = [...byUser.entries()]
            .filter(([userId]) => userId !== briefing.host_user_id)
            .map(([userId, entry]) => ({
                user_id: userId,
                name: names.get(userId) ?? `User ${userId}`,
                site: expectedById.get(userId)?.site ?? null,
                first_joined_at: entry.first_joined_at,
                last_seen_at: entry.last_seen_at,
                seconds: entry.seconds,
                visits: entry.visits,
                late: entry.first_joined_at.getTime() > lateAfter,
                inside: inside(entry.last_seen_at),
            }))
        const absent = expected
            .filter((person) => !byUser.has(person.id))
            .map((person) => ({ user_id: person.id, name: person.name, site: person.site }))

        return success('Daftar hadir briefing', {
            briefing: {
                id: briefing.id,
                title: briefing.title,
                host_name: names.get(briefing.host_user_id) ?? null,
                started_at: briefing.started_at,
                ended_at: briefing.ended_at,
            },
            attended,
            absent,
            expected_count: expected.length,
        })
    }

    /** Batalkan jadwal briefing (pemimpin atau root). */
    async cancelSchedule(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const id = ctx.params.id
        if (typeof id !== 'string' || !/^\d+$/.test(id)) {
            return ctx.response.status(404).send(fail('Jadwal tidak ditemukan'))
        }
        const schedule = await db.from('briefing_schedules').where('id', Number(id)).first()
        if (!schedule) return ctx.response.status(404).send(fail('Jadwal tidak ditemukan'))
        if (schedule.host_user_id !== access.userId && !access.roles.includes('super_admin')) {
            return ctx.response
                .status(403)
                .send(fail('Hanya pemimpin briefing yang bisa membatalkan jadwalnya'))
        }
        await db
            .from('briefing_schedules')
            .where('id', schedule.id)
            .update({ is_active: false, next_run_at: null, updated_at: new Date() })
        await writeActivity(ctx, {
            logName: 'briefings',
            description: `Membatalkan jadwal briefing "${schedule.title}"`,
            event: 'deleted',
            subjectType: null,
            subjectId: schedule.id,
            properties: {},
            organizationId: null,
        })
        return success('Jadwal briefing dibatalkan')
    }
}

/**
 * Orang yang diharapkan hadir: peserta pilihan, atau semua user aktif dengan
 * peran undangan di site undangan (kosong = semua site). Maksimal 500.
 */
async function expectedAttendees(briefing: BriefingRow) {
    const query = db
        .from('users')
        .leftJoin('organizations', 'organizations.id', 'users.organization_id')
        .whereNull('users.deleted_at')
        .where('users.is_active', true)
        .orderBy('users.name')
        .limit(500)
        .select('users.id', 'users.name', 'organizations.name as site_name')
    if (invitedOf(briefing).length) {
        query.whereIn('users.id', invitedOf(briefing))
    } else {
        if (!briefing.allowed_roles.length) return []
        query.whereIn(
            'users.id',
            db
                .from('model_has_roles')
                .join('roles', 'roles.id', 'model_has_roles.role_id')
                .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
                .whereIn('roles.name', briefing.allowed_roles)
                .select('model_has_roles.model_id')
        )
        const sites = briefing.allowed_organization_ids
        if (sites.length) {
            query.where((scope) => {
                scope
                    .whereIn('users.organization_id', sites)
                    .orWhereIn(
                        'users.id',
                        db
                            .from('user_site_access')
                            .whereIn('organization_id', sites)
                            .select('user_id')
                    )
            })
        }
    }
    const rows = await query
    return rows.map((row) => ({
        id: Number(row.id),
        name: row.name as string,
        site: (row.site_name as string | null) ?? null,
    }))
}

function connection(briefing: BriefingRow, ctx: HttpContext, isHost: boolean) {
    const user = ctx.authUser!
    return {
        briefing: {
            id: briefing.id,
            title: briefing.title,
            is_host: isHost,
            // Peserta pilihan = rapat kecil: semua masuk dengan kamera menyala
            // supaya saling melihat.
            camera_on_join: isHost || invitedOf(briefing).length > 0,
            started_at: briefing.started_at,
        },
        livekit_url: liveKitConfig().url,
        room: roomForBriefing(briefing.id),
        token: briefingToken(briefing, { id: user.id, name: user.name }),
    }
}

const invitedOf = (briefing: BriefingRow) => briefing.invited_user_ids ?? []

async function findBriefing(id: unknown): Promise<BriefingRow | null> {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) return null
    return (await db.from('briefings').where('id', Number(id)).first()) ?? null
}

/** Site yang bisa dipilih pemimpin saat memulai briefing. */
async function sitesFor(access: Parameters<typeof sitesOf>[0]) {
    const own = sitesOf(access)
    const query = db
        .from('organizations')
        .whereNull('deleted_at')
        .where('is_active', true)
        .orderBy('name')
        .select('id', 'name')
    if (own !== 'all') query.whereIn('id', own)
    return query
}

async function userNames(ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map()
    const rows = await db
        .from('users')
        .whereIn('id', [...new Set(ids)])
        .select('id', 'name')
    return new Map(rows.map((row) => [Number(row.id), row.name]))
}

async function organizationNames(ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map()
    const rows = await db
        .from('organizations')
        .whereIn('id', [...new Set(ids)])
        .select('id', 'name')
    return new Map(rows.map((row) => [Number(row.id), row.name]))
}
