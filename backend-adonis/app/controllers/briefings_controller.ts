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
    closeBriefingRoom,
    roomForBriefing,
    sitesOf,
    type BriefingRow,
} from '#services/briefing'
import { liveKitConfig } from '#services/livekit'

const AUDIENCE_KEYS = Object.keys(BRIEFING_AUDIENCE_ROLES) as Array<
    keyof typeof BRIEFING_AUDIENCE_ROLES
>

const startValidator = vine.compile(
    vine.object({
        title: vine.string().trim().minLength(1).maxLength(120),
        roles: vine.array(vine.enum(AUDIENCE_KEYS)).minLength(1),
        organization_ids: vine.array(vine.number().withoutDecimals().positive()).optional(),
    })
)

/**
 * Briefing: rapat video Live dalam satu ruang. Pemimpin (leader, admin, root)
 * memilih peran & site yang boleh bergabung -- lihat app/services/briefing.ts.
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
        const names = await userNames(joinable.map((briefing) => briefing.host_user_id))
        const siteNames = await organizationNames(
            joinable.flatMap((b) => b.allowed_organization_ids)
        )

        return success('Briefing', {
            can_host: canHost,
            roles: AUDIENCE_KEYS.map((value) => ({ value, label: BRIEFING_AUDIENCE_ROLES[value] })),
            sites: hostSites,
            items: joinable.map((briefing) => ({
                id: briefing.id,
                title: briefing.title,
                host_name: names.get(briefing.host_user_id) ?? null,
                is_host: briefing.host_user_id === access.userId,
                roles: briefing.allowed_roles,
                sites: briefing.allowed_organization_ids.map(
                    (id) => siteNames.get(id) ?? `Site ${id}`
                ),
                started_at: briefing.started_at,
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

        // Site yang diundang harus site yang dipegang pemimpin; kosong = semua
        // site miliknya (root: benar-benar semua site).
        const own = sitesOf(access)
        let siteIds = [...new Set(input.organization_ids ?? [])]
        if (own !== 'all') {
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
        const [row] = await db
            .table('briefings')
            .insert({
                title: input.title,
                host_user_id: access.userId,
                allowed_roles: JSON.stringify([...new Set(input.roles)]),
                allowed_organization_ids: JSON.stringify(siteIds),
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
            await db
                .from('briefings')
                .where('id', briefing.id)
                .update({ ended_at: new Date(), updated_at: new Date() })
            await closeBriefingRoom(briefing.id)
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
}

function connection(briefing: BriefingRow, ctx: HttpContext, isHost: boolean) {
    const user = ctx.authUser!
    return {
        briefing: {
            id: briefing.id,
            title: briefing.title,
            is_host: isHost,
            started_at: briefing.started_at,
        },
        livekit_url: liveKitConfig().url,
        room: roomForBriefing(briefing.id),
        token: briefingToken(briefing, { id: user.id, name: user.name }, isHost),
    }
}

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
