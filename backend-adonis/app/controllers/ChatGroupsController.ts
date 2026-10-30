import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'
import { accessOf } from '#services/access'
import { writeActivity } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import { colleaguesOf } from '#services/people'
import { chatImagesDiskName, disk } from '#services/storage'
import {
    bodyInput,
    findMessage,
    imageInput,
    integerInput,
    invalid,
    messages,
    toPayload,
    type MessageRow,
    type ValidationErrors,
} from '#controllers/chat_messages_controller'

const PAGE_SIZE = 50
const MAX_MEMBERS = 300

const storeValidator = vine.compile(
    vine.object({
        name: vine.string().trim().minLength(1).maxLength(80),
        user_ids: vine
            .array(vine.number().withoutDecimals().positive())
            .maxLength(MAX_MEMBERS)
            .optional(),
    })
)
const renameValidator = vine.compile(
    vine.object({ name: vine.string().trim().minLength(1).maxLength(80) })
)
const membersValidator = vine.compile(
    vine.object({
        user_ids: vine
            .array(vine.number().withoutDecimals().positive())
            .minLength(1)
            .maxLength(MAX_MEMBERS),
    })
)

type GroupRow = { id: number; name: string; created_by: number | null; created_at: Date | null }
type Membership = { is_admin: boolean; last_read_message_id: number | null }

/**
 * Grup chat buatan user. Siapa pun bisa membuat grup dengan nama sendiri dan
 * mengundang rekan dari site yang dipegangnya (aturan sama dengan peserta
 * briefing, lihat colleaguesOf). Pengelola grup (pembuatnya, atau anggota yang
 * dijadikan pengelola) mengganti nama, menambah & mengeluarkan anggota, dan
 * menghapus grup. Membaca & mengirim pesan hanya untuk anggota.
 *
 * Realtime lewat realtime-gateway dengan token user yang sedang chat (sama
 * dengan chat site); respons pesan membawa member_ids supaya gateway hanya
 * menyiarkan ke anggota yang masih tercatat.
 */
export default class ChatGroupsController {
    /** Grup yang diikuti user ini, dengan pesan terakhir & jumlah belum dibaca. */
    async index(ctx: HttpContext) {
        const userId = ctx.authUser!.id
        const groups = await db
            .from('chat_groups as g')
            .join('chat_group_members as me', (join) => {
                join.on('me.chat_group_id', 'g.id').andOnVal('me.user_id', userId)
            })
            .select(
                'g.id',
                'g.name',
                'g.created_by',
                'g.created_at',
                'me.is_admin',
                'me.last_read_message_id',
                db.raw(
                    '(select count(*) from chat_group_members m where m.chat_group_id = g.id)::int as member_count'
                ),
                db.raw(
                    `(select count(*) from chat_messages c where c.chat_group_id = g.id and c.user_id <> ? and c.id > coalesce(me.last_read_message_id, 0))::int as unread_count`,
                    [userId]
                ),
                db.raw(
                    '(select max(c.id) from chat_messages c where c.chat_group_id = g.id) as last_message_id'
                )
            )
        const lastIds = groups.map((group) => group.last_message_id).filter(Boolean)
        const lastRows: MessageRow[] = lastIds.length
            ? await messages().whereIn('m.id', lastIds.map(Number))
            : []
        const lastById = new Map(lastRows.map((row) => [row.id, row]))

        const items = groups.map((group) => {
            const last = lastById.get(Number(group.last_message_id))
            return {
                id: Number(group.id),
                name: group.name,
                is_admin: group.is_admin,
                member_count: group.member_count,
                unread_count: group.unread_count,
                last_read_message_id: group.last_read_message_id,
                last_message: last
                    ? {
                          id: last.id,
                          user_id: last.user_id,
                          user_name: last.user_name,
                          body: last.body,
                          has_image: last.image_path !== null,
                          created_at: last.created_at,
                      }
                    : null,
                created_at: group.created_at,
            }
        })
        // Percakapan yang terakhir aktif di atas.
        items.sort((a, b) => {
            const at = (item: (typeof items)[number]) =>
                new Date(item.last_message?.created_at ?? item.created_at ?? 0).getTime()
            return at(b) - at(a)
        })
        return success('Grup chat', { items })
    }

    /** Orang yang bisa dimasukkan ke grup oleh user ini. */
    async candidates(ctx: HttpContext) {
        const access = await accessOf(ctx)
        return success('Calon anggota', { items: await colleaguesOf(access) })
    }

    async store(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const input = await ctx.request.validateUsing(storeValidator)
        const userIds = [...new Set(input.user_ids ?? [])].filter((id) => id !== access.userId)
        if (!(await allColleagues(access, userIds))) {
            return ctx.response.status(403).send(fail('Ada orang yang tidak berada di site Anda'))
        }

        const now = new Date()
        const group = await db.transaction(async (trx) => {
            const [row] = await trx
                .table('chat_groups')
                .insert({
                    name: input.name,
                    created_by: access.userId,
                    created_at: now,
                    updated_at: now,
                })
                .returning(['id', 'name'])
            await trx.table('chat_group_members').multiInsert([
                { chat_group_id: row.id, user_id: access.userId, is_admin: true, joined_at: now },
                ...userIds.map((userId) => ({
                    chat_group_id: row.id,
                    user_id: userId,
                    is_admin: false,
                    joined_at: now,
                })),
            ])
            return row
        })
        await writeActivity(ctx, {
            logName: 'chat_groups',
            description: `Membuat grup chat "${input.name}" (${userIds.length + 1} anggota)`,
            event: 'created',
            subjectType: null,
            subjectId: group.id,
            properties: { user_ids: userIds },
            organizationId: null,
        })
        return ctx.response
            .status(201)
            .send(success('Grup dibuat', { id: Number(group.id), name: group.name }))
    }

    /** Detail grup & anggotanya (anggota saja). */
    async show(ctx: HttpContext) {
        const group = await findGroup(ctx.params.id)
        if (!group) return notFound(ctx)
        const membership = await membershipOf(group.id, ctx.authUser!.id)
        if (!membership) return notFound(ctx)

        const members = await db
            .from('chat_group_members as m')
            .join('users as u', 'u.id', 'm.user_id')
            .leftJoin('organizations as o', 'o.id', 'u.organization_id')
            .where('m.chat_group_id', group.id)
            .orderBy('m.is_admin', 'desc')
            .orderBy('u.name')
            .select('u.id', 'u.name', 'o.name as site_name', 'm.is_admin', 'm.joined_at')
        return success('Grup chat', {
            id: group.id,
            name: group.name,
            is_admin: membership.is_admin,
            created_by: group.created_by,
            members: members.map((member) => ({
                id: Number(member.id),
                name: member.name,
                site: member.site_name,
                is_admin: member.is_admin,
                joined_at: member.joined_at,
            })),
            member_ids: members.map((member) => Number(member.id)),
        })
    }

    async update(ctx: HttpContext) {
        const group = await adminGroup(ctx)
        if (!group) return
        const { name } = await ctx.request.validateUsing(renameValidator)
        await db.from('chat_groups').where('id', group.id).update({ name, updated_at: new Date() })
        return success('Nama grup diganti', { id: group.id, name })
    }

    async destroy(ctx: HttpContext) {
        const group = await adminGroup(ctx)
        if (!group) return
        await db.from('chat_groups').where('id', group.id).delete()
        await writeActivity(ctx, {
            logName: 'chat_groups',
            description: `Menghapus grup chat "${group.name}"`,
            event: 'deleted',
            subjectType: null,
            subjectId: group.id,
            properties: {},
            organizationId: null,
        })
        return success('Grup dihapus')
    }

    /** Tambah anggota (pengelola grup); harus rekan di site yang dipegang pengelola itu. */
    async addMembers(ctx: HttpContext) {
        const group = await adminGroup(ctx)
        if (!group) return
        const access = await accessOf(ctx)
        const input = await ctx.request.validateUsing(membersValidator)
        const userIds = [...new Set(input.user_ids)].filter((id) => id !== access.userId)
        if (!(await allColleagues(access, userIds))) {
            return ctx.response.status(403).send(fail('Ada orang yang tidak berada di site Anda'))
        }
        const count = await db
            .from('chat_group_members')
            .where('chat_group_id', group.id)
            .count('* as total')
            .first()
        if (Number(count?.total ?? 0) + userIds.length > MAX_MEMBERS) {
            return ctx.response.status(422).send(fail(`Satu grup maksimal ${MAX_MEMBERS} anggota`))
        }
        const now = new Date()
        if (userIds.length) {
            await db
                .table('chat_group_members')
                .multiInsert(
                    userIds.map((userId) => ({
                        chat_group_id: group.id,
                        user_id: userId,
                        is_admin: false,
                        joined_at: now,
                    }))
                )
                .onConflict(['chat_group_id', 'user_id'])
                .ignore()
        }
        return success('Anggota ditambahkan')
    }

    /**
     * Keluarkan anggota (pengelola grup), atau keluar dari grup (diri sendiri).
     * Grup tanpa anggota dihapus; pengelola terakhir yang keluar digantikan
     * anggota terlama.
     */
    async removeMember(ctx: HttpContext) {
        const group = await findGroup(ctx.params.id)
        if (!group) return notFound(ctx)
        const me = ctx.authUser!.id
        const membership = await membershipOf(group.id, me)
        if (!membership) return notFound(ctx)
        const target = Number(ctx.params.userId)
        if (!Number.isSafeInteger(target)) return notFound(ctx)
        if (target !== me && !membership.is_admin) {
            return ctx.response
                .status(403)
                .send(fail('Hanya pengelola grup yang bisa mengeluarkan anggota'))
        }

        await db.transaction(async (trx) => {
            await trx
                .from('chat_group_members')
                .where('chat_group_id', group.id)
                .where('user_id', target)
                .delete()
            const remaining = await trx
                .from('chat_group_members')
                .where('chat_group_id', group.id)
                .orderBy('joined_at')
                .orderBy('user_id')
                .select('user_id', 'is_admin')
            if (!remaining.length) {
                await trx.from('chat_groups').where('id', group.id).delete()
            } else if (!remaining.some((member) => member.is_admin)) {
                await trx
                    .from('chat_group_members')
                    .where('chat_group_id', group.id)
                    .where('user_id', remaining[0].user_id)
                    .update({ is_admin: true })
            }
        })
        return success(target === me ? 'Anda keluar dari grup' : 'Anggota dikeluarkan')
    }

    /** Jadikan / batalkan anggota sebagai pengelola grup. */
    async setAdmin(ctx: HttpContext) {
        const group = await adminGroup(ctx)
        if (!group) return
        const target = Number(ctx.params.userId)
        const isAdmin = ctx.request.input('is_admin') === true
        if (!Number.isSafeInteger(target) || target === ctx.authUser!.id) {
            return ctx.response.status(422).send(fail('Pilih anggota lain'))
        }
        const updated = await db
            .from('chat_group_members')
            .where('chat_group_id', group.id)
            .where('user_id', target)
            .update({ is_admin: isAdmin })
        if (!Number(updated)) return notFound(ctx)
        return success(isAdmin ? 'Dijadikan pengelola' : 'Bukan pengelola lagi')
    }

    /** Riwayat pesan (anggota saja); before_id untuk memuat yang lebih lama. */
    async messages(ctx: HttpContext) {
        const group = await memberGroup(ctx)
        if (!group) return
        const errors: ValidationErrors = {}
        const beforeId = integerInput(ctx.request.input('before_id'), 'before_id', errors)
        if (Object.keys(errors).length) return invalid(ctx, errors)

        const query = messages().where('m.chat_group_id', group.id)
        if (beforeId) query.where('m.id', '<', beforeId)
        const latest: MessageRow[] = await query.orderBy('m.id', 'desc').limit(PAGE_SIZE)
        const rows = latest.reverse()
        return success('Riwayat grup', {
            chat_group_id: group.id,
            messages: rows.map((row) => toPayload(row)),
            has_more: rows.length === PAGE_SIZE,
            member_ids: await memberIds(group.id),
        })
    }

    /** Satu pesan grup -- dipakai gateway untuk menyiarkan pesan bergambar. */
    async message(ctx: HttpContext) {
        const group = await memberGroup(ctx)
        if (!group) return
        const row = await findMessage(ctx.params.messageId)
        if (!row || row.chat_group_id !== group.id) return notFound(ctx)
        return success('Pesan', { ...toPayload(row), member_ids: await memberIds(group.id) })
    }

    async send(ctx: HttpContext) {
        const group = await memberGroup(ctx)
        if (!group) return
        const errors: ValidationErrors = {}
        const replyToId = integerInput(ctx.request.input('reply_to_id'), 'reply_to_id', errors)
        const body = bodyInput(ctx.request.input('body'), errors)
        const image = await imageInput(ctx, errors)
        if (Object.keys(errors).length) return invalid(ctx, errors)
        if (body === '' && !image) {
            return ctx.response.status(422).send(fail('Pesan tidak boleh kosong'))
        }

        if (replyToId !== null) {
            const original = await db
                .from('chat_messages')
                .where('id', replyToId)
                .where('chat_group_id', group.id)
                .first()
            if (!original) {
                return ctx.response.status(422).send(fail('Pesan yang dibalas tidak ditemukan'))
            }
        }

        let imageAttributes = {}
        if (image) {
            const path = `chat/group-${group.id}/${randomUUID()}.${image.extension}`
            try {
                await disk(chatImagesDiskName()).put(path, image.contents, image.mime)
            } catch (error) {
                logger.error({ err: error }, 'Gambar chat grup gagal disimpan')
                return ctx.response
                    .status(503)
                    .send(
                        fail('Gambar gagal disimpan ke penyimpanan server, coba lagi sebentar lagi')
                    )
            }
            imageAttributes = {
                image_path: path,
                image_mime: image.mime,
                image_width: image.width,
                image_height: image.height,
            }
        }

        const now = new Date(Math.floor(Date.now() / 1000) * 1000)
        const [created] = await db
            .table('chat_messages')
            .insert({
                organization_id: null,
                chat_group_id: group.id,
                user_id: ctx.authUser!.id,
                reply_to_id: replyToId,
                body: body === '' ? null : body,
                ...imageAttributes,
                created_at: now,
                updated_at: now,
            })
            .returning('id')
        // Pesan sendiri = sudah dibaca.
        await db
            .from('chat_group_members')
            .where('chat_group_id', group.id)
            .where('user_id', ctx.authUser!.id)
            .update({ last_read_message_id: created.id })

        const row = (await findMessage(created.id))!
        row.user_name = ctx.authUser!.name
        return ctx.response.status(201).send(
            success('Pesan terkirim', {
                ...toPayload(row),
                member_ids: await memberIds(group.id),
            })
        )
    }

    /** Tandai sudah dibaca sampai pesan ini. */
    async read(ctx: HttpContext) {
        const group = await memberGroup(ctx)
        if (!group) return
        const messageId = Number(ctx.request.input('message_id'))
        if (!Number.isSafeInteger(messageId) || messageId <= 0) {
            return ctx.response.status(422).send(fail('Pesan tidak valid'))
        }
        await db
            .from('chat_group_members')
            .where('chat_group_id', group.id)
            .where('user_id', ctx.authUser!.id)
            .where((query) =>
                query
                    .whereNull('last_read_message_id')
                    .orWhere('last_read_message_id', '<', messageId)
            )
            .update({ last_read_message_id: messageId })
        return success('Ditandai sudah dibaca')
    }
}

async function findGroup(id: unknown): Promise<GroupRow | null> {
    if (typeof id !== 'string' || !/^\d{1,18}$/.test(id)) return null
    const row = await db.from('chat_groups').where('id', Number(id)).first()
    return row ? { ...row, id: Number(row.id) } : null
}

async function membershipOf(groupId: number, userId: number): Promise<Membership | null> {
    return (
        (await db
            .from('chat_group_members')
            .where('chat_group_id', groupId)
            .where('user_id', userId)
            .select('is_admin', 'last_read_message_id')
            .first()) ?? null
    )
}

async function memberIds(groupId: number): Promise<number[]> {
    const rows = await db
        .from('chat_group_members')
        .where('chat_group_id', groupId)
        .select('user_id')
    return rows.map((row) => Number(row.user_id))
}

/** Grup yang diikuti user ini; bukan anggota = 404 (keberadaan grup tidak dibocorkan). */
async function memberGroup(ctx: HttpContext): Promise<GroupRow | null> {
    const group = await findGroup(ctx.params.id)
    if (group && (await membershipOf(group.id, ctx.authUser!.id))) return group
    notFound(ctx)
    return null
}

async function adminGroup(ctx: HttpContext): Promise<GroupRow | null> {
    const group = await findGroup(ctx.params.id)
    const membership = group ? await membershipOf(group.id, ctx.authUser!.id) : null
    if (!group || !membership) {
        notFound(ctx)
        return null
    }
    if (!membership.is_admin) {
        ctx.response.status(403).send(fail('Hanya pengelola grup yang bisa melakukan ini'))
        return null
    }
    return group
}

async function allColleagues(
    access: Awaited<ReturnType<typeof accessOf>>,
    userIds: number[]
): Promise<boolean> {
    if (!userIds.length) return true
    const colleagues = await colleaguesOf(access)
    const allowed = new Set(colleagues.map((person) => person.id))
    return userIds.every((id) => allowed.has(id))
}

function notFound(ctx: HttpContext) {
    return ctx.response.status(404).send(fail('Grup tidak ditemukan'))
}
