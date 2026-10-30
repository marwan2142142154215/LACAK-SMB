import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'
import { accessOf, type Access } from '#services/access'
import { writeActivity } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import { BRIEFING_AUDIENCE_ROLES, sitesOf as userSitesOf } from '#services/briefing'
import { isManager, managedSites } from '#services/managed_sites'
import { raiseAlert } from '#services/work_alerts'
import { sitesOf } from '#controllers/work_shifts_controller'

const AUDIENCE_KEYS = Object.keys(BRIEFING_AUDIENCE_ROLES) as Array<
    keyof typeof BRIEFING_AUDIENCE_ROLES
>

const storeValidator = vine.compile(
    vine.object({
        title: vine.string().trim().minLength(1).maxLength(120),
        body: vine.string().trim().minLength(1).maxLength(5000),
        // Kosong = semua peran.
        roles: vine.array(vine.enum(AUDIENCE_KEYS)).optional(),
        // Kosong = semua site yang dikelola penulis.
        organization_ids: vine.array(vine.number().withoutDecimals().positive()).optional(),
        is_important: vine.boolean().optional(),
        expires_at: vine.string().optional(),
        notify_telegram: vine.boolean().optional(),
    })
)

type AnnouncementRow = {
    id: number
    title: string
    body: string
    author_id: number
    allowed_roles: string[]
    allowed_organization_ids: number[]
    is_important: boolean
    expires_at: Date | null
    created_at: Date
}

/** Pengumuman ini untuk user ini? Penulis & root selalu melihatnya. */
export function canSeeAnnouncement(access: Access, row: AnnouncementRow): boolean {
    if (row.author_id === access.userId || access.roles.includes('super_admin')) return true
    if (
        row.allowed_roles.length &&
        !access.roles.some((role) => row.allowed_roles.includes(role))
    ) {
        return false
    }
    if (!row.allowed_organization_ids.length) return true
    const sites = userSitesOf(access)
    if (sites === 'all') return true
    return sites.some((id) => row.allowed_organization_ids.includes(id))
}

/**
 * Pengumuman dari pengelola site ke staf yang dipilih menurut peran & site.
 * Tampil sebagai banner di dashboard sampai ditandai sudah dibaca; penulis
 * melihat siapa saja yang sudah membacanya.
 */
export default class AnnouncementsController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const now = new Date()
        const rows: AnnouncementRow[] = await db
            .from('announcements')
            .where((query) => query.whereNull('expires_at').orWhere('expires_at', '>', now))
            .orderBy('created_at', 'desc')
            .limit(200)
        const visible = rows.filter((row) => canSeeAnnouncement(access, row)).slice(0, 50)
        const ids = visible.map((row) => row.id)

        const [reads, readCounts, authors] = await Promise.all([
            ids.length
                ? db
                      .from('announcement_reads')
                      .whereIn('announcement_id', ids)
                      .where('user_id', access.userId)
                      .select('announcement_id')
                : [],
            ids.length
                ? db
                      .from('announcement_reads')
                      .whereIn('announcement_id', ids)
                      .groupBy('announcement_id')
                      .select('announcement_id')
                      .count('* as total')
                : [],
            visible.length
                ? db
                      .from('users')
                      .whereIn('id', [...new Set(visible.map((row) => row.author_id))])
                      .select('id', 'name')
                : [],
        ])
        const readIds = new Set(reads.map((row) => Number(row.announcement_id)))
        const countOf = new Map(
            readCounts.map((row: any) => [Number(row.announcement_id), Number(row.total)])
        )
        const authorOf = new Map(authors.map((row) => [Number(row.id), row.name as string]))
        const siteIds = [...new Set(visible.flatMap((row) => row.allowed_organization_ids))]
        const audienceSites = await sitesOf(siteIds)
        const siteNames = new Map(audienceSites.map((site) => [site.id, site.name]))

        const canCreate = isManager(access)
        return success('Pengumuman', {
            can_create: canCreate,
            roles: AUDIENCE_KEYS.map((value) => ({ value, label: BRIEFING_AUDIENCE_ROLES[value] })),
            sites: canCreate ? await sitesOf(managedSites(access)) : [],
            unread_count: visible.filter(
                (row) => !readIds.has(row.id) && row.author_id !== access.userId
            ).length,
            items: visible.map((row) => {
                const mine = row.author_id === access.userId
                return {
                    id: row.id,
                    title: row.title,
                    body: row.body,
                    author_name: authorOf.get(row.author_id) ?? null,
                    is_mine: mine,
                    can_delete: mine || access.roles.includes('super_admin'),
                    is_important: row.is_important,
                    is_read: mine || readIds.has(row.id),
                    roles: row.allowed_roles,
                    sites: row.allowed_organization_ids.map(
                        (id) => siteNames.get(id) ?? `Site ${id}`
                    ),
                    read_count:
                        mine || access.roles.includes('super_admin')
                            ? (countOf.get(row.id) ?? 0)
                            : null,
                    expires_at: row.expires_at,
                    created_at: row.created_at,
                }
            }),
        })
    }

    async store(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!isManager(access)) {
            return ctx.response
                .status(403)
                .send(fail('Hanya pengelola site yang bisa membuat pengumuman'))
        }
        const input = await ctx.request.validateUsing(storeValidator)

        const own = managedSites(access)
        let siteIds = [...new Set(input.organization_ids ?? [])]
        if (own !== 'all') {
            if (siteIds.some((id) => !own.includes(id))) {
                return ctx.response.status(403).send(fail('Ada site yang tidak Anda kelola'))
            }
            // Kosong berarti semua site -- pengelola biasa dibatasi ke site miliknya.
            if (!siteIds.length) siteIds = own
        }

        let expiresAt: Date | null = null
        if (input.expires_at) {
            expiresAt = new Date(input.expires_at)
            if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
                return ctx.response.status(422).send(fail('Batas tampil harus di masa depan'))
            }
        }

        const now = new Date()
        const [row] = await db
            .table('announcements')
            .insert({
                title: input.title,
                body: input.body,
                author_id: access.userId,
                allowed_roles: JSON.stringify([...new Set(input.roles ?? [])]),
                allowed_organization_ids: JSON.stringify(siteIds),
                is_important: input.is_important ?? false,
                expires_at: expiresAt,
                created_at: now,
                updated_at: now,
            })
            .returning('*')
        await writeActivity(ctx, {
            logName: 'announcements',
            description: `Membuat pengumuman "${input.title}"`,
            event: 'created',
            subjectType: null,
            subjectId: row.id,
            properties: { roles: input.roles ?? [], organization_ids: siteIds },
            organizationId: siteIds.length === 1 ? siteIds[0] : null,
        })

        if (input.notify_telegram) {
            const everySite = siteIds.length ? [] : await sitesOf('all')
            const targets = siteIds.length ? siteIds : everySite.map((site) => site.id)
            const author = ctx.authUser!.name
            for (const organizationId of targets) {
                await raiseAlert({
                    organizationId,
                    userId: access.userId,
                    type: 'announcement',
                    key: `announcement:${row.id}:${organizationId}`,
                    message: `${input.is_important ? '❗' : '📢'} Pengumuman dari ${author}: ${input.title}\n\n${input.body}`,
                    now,
                })
            }
        }
        return ctx.response.status(201).send(success('Pengumuman diterbitkan', { id: row.id }))
    }

    async read(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const row = await findAnnouncement(ctx.params.id)
        if (!row || !canSeeAnnouncement(access, row)) {
            return ctx.response.status(404).send(fail('Pengumuman tidak ditemukan'))
        }
        await db
            .table('announcement_reads')
            .insert({ announcement_id: row.id, user_id: access.userId, read_at: new Date() })
            .onConflict(['announcement_id', 'user_id'])
            .ignore()
        return success('Ditandai sudah dibaca')
    }

    /** Siapa saja yang sudah membaca (penulis atau root). */
    async readers(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const row = await findAnnouncement(ctx.params.id)
        if (!row) return ctx.response.status(404).send(fail('Pengumuman tidak ditemukan'))
        if (row.author_id !== access.userId && !access.roles.includes('super_admin')) {
            return ctx.response.status(403).send(fail('Hanya penulis yang bisa melihat pembacanya'))
        }
        const readers = await db
            .from('announcement_reads')
            .join('users', 'users.id', 'announcement_reads.user_id')
            .where('announcement_reads.announcement_id', row.id)
            .orderBy('announcement_reads.read_at')
            .select('users.id', 'users.name', 'announcement_reads.read_at')
        return success('Pembaca pengumuman', {
            items: readers.map((reader) => ({
                user_id: Number(reader.id),
                name: reader.name,
                read_at: reader.read_at,
            })),
        })
    }

    async destroy(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const row = await findAnnouncement(ctx.params.id)
        if (!row) return ctx.response.status(404).send(fail('Pengumuman tidak ditemukan'))
        if (row.author_id !== access.userId && !access.roles.includes('super_admin')) {
            return ctx.response.status(403).send(fail('Hanya penulis yang bisa menghapusnya'))
        }
        await db.from('announcements').where('id', row.id).delete()
        await writeActivity(ctx, {
            logName: 'announcements',
            description: `Menghapus pengumuman "${row.title}"`,
            event: 'deleted',
            subjectType: null,
            subjectId: row.id,
            properties: {},
            organizationId: null,
        })
        return success('Pengumuman dihapus')
    }
}

async function findAnnouncement(id: unknown): Promise<AnnouncementRow | null> {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) return null
    return (await db.from('announcements').where('id', Number(id)).first()) ?? null
}
