import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can, hasRole, type Access } from '#services/access'
import { fail, success } from '#services/api_response'
import { laravelDate } from '#services/activity_log'
import { hasCrossOrganizationAccess } from '#services/organization_scope'
import { permissionNamesOf, roleNamesOf } from '#services/permissions'
import { storeTelegramUserLinkValidator } from '#validators/rules'
import { stringInput } from '#controllers/telegram_bindings_controller'

type LinkedUser = { id: number; name: string; username: string; organization_id: number | null }

/**
 * SENGAJA tidak pakai authorizedOrganizationId() -- fungsi itu mengembalikan
 * null baik untuk "ditolak" MAUPUN untuk "diizinkan tapi organization_id
 * target-nya memang null" (kasus nyata: target-nya sendiri super_admin,
 * organization_id-nya null by design). Dua arti berbeda ketemu di satu nilai
 * null -- cek eksplisit di sini supaya tidak salah tolak admin yang
 * menautkan sesama super_admin.
 */
export function canManageStaffLink(
    requester: Access,
    target: { organization_id: number | null } | null
): boolean {
    if (hasCrossOrganizationAccess(requester)) return true
    return (
        target !== null &&
        target.organization_id !== null &&
        target.organization_id === requester.organizationId
    )
}

/** User yang belum di-soft-delete (Eloquent SoftDeletes). */
function activeUsers() {
    return db.from('users').whereNull('deleted_at')
}

/**
 * Tautan akun Telegram pribadi staf -> akun login staf -- padanan
 * TelegramUserLinkController di backend-api, kontrak sama. ID Telegram
 * didapat dari Telegram langsung (/start ke bot atau pesan terusan), bukan
 * diketik bebas, supaya tidak salah tautan ke orang lain.
 */
export default class TelegramUserLinksController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'telegram.manage')) return forbidden(ctx)

        // telegram_user_links tidak punya organization_id langsung (yang
        // diikat ke tabel ini SIAPA orangnya, bukan site mana) -- scoping-nya
        // lewat organization_id milik user yang ditautkan. site_admin cuma
        // boleh lihat tautan stafnya sendiri, bukan seluruh site lain.
        const query = db
            .from('telegram_user_links')
            .join('users', 'users.id', 'telegram_user_links.user_id')
            .whereNull('users.deleted_at')
            .orderBy('telegram_user_links.id', 'desc')
            .select(
                'telegram_user_links.id',
                'telegram_user_links.telegram_user_id',
                'telegram_user_links.telegram_username',
                'users.id as user_id',
                'users.name as user_name',
                'users.username as user_username'
            )

        if (!hasCrossOrganizationAccess(access)) {
            if (access.organizationId === null) {
                // where('organization_id', null) Eloquent = IS NULL, tapi lewat
                // whereHas dengan nilai null tidak ada yang cocok.
                query.whereRaw('false')
            } else {
                query.where('users.organization_id', access.organizationId)
            }
        }

        const links = await query

        return success(
            'Daftar tautan akun Telegram',
            links.map((link) => ({
                id: link.id,
                telegram_user_id: link.telegram_user_id,
                telegram_username: link.telegram_username,
                user: { id: link.user_id, name: link.user_name, username: link.user_username },
            }))
        )
    }

    async store(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'telegram.manage')) return forbidden(ctx)

        const input = await ctx.request.validateUsing(storeTelegramUserLinkValidator)

        // User::findOrFail(): exists:users,id lolos untuk user yang sudah di-soft-delete,
        // tapi findOrFail menganggapnya tidak ada (404).
        const target: LinkedUser | null =
            (await activeUsers().where('id', input.user_id).first()) ?? null
        if (!target) return ctx.response.status(404).send(fail('Data tidak ditemukan'))

        if (!canManageStaffLink(access, target)) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang menautkan akun staf ini'))
        }

        // updateOrCreate() berkunci telegram_user_id.
        const now = new Date()
        const values = {
            user_id: input.user_id,
            telegram_username: input.telegram_username ?? null,
            created_by: access.userId,
        }
        const existing = await db
            .from('telegram_user_links')
            .where('telegram_user_id', input.telegram_user_id)
            .first()

        let link: Record<string, unknown>
        if (existing) {
            const dirty =
                existing.user_id !== values.user_id ||
                existing.telegram_username !== values.telegram_username ||
                existing.created_by !== values.created_by
            ;[link] = dirty
                ? await db
                      .from('telegram_user_links')
                      .where('id', existing.id)
                      .update({ ...values, updated_at: now })
                      .returning('*')
                : [existing]
        } else {
            ;[link] = await db
                .table('telegram_user_links')
                .insert({
                    telegram_user_id: input.telegram_user_id,
                    ...values,
                    created_at: now,
                    updated_at: now,
                })
                .returning('*')
        }

        // $link->load('user:id,name,username') lalu diserialisasi apa adanya.
        return ctx.response.status(201).send(
            success('Akun Telegram berhasil ditautkan', {
                id: link.id,
                user_id: link.user_id,
                telegram_user_id: link.telegram_user_id,
                telegram_username: link.telegram_username,
                created_by: link.created_by,
                created_at: laravelDate(link.created_at as Date | null),
                updated_at: laravelDate(link.updated_at as Date | null),
                user: { id: target.id, name: target.name, username: target.username },
            })
        )
    }

    async destroy(ctx: HttpContext) {
        // Route model binding (404) jalan sebelum cek izin di backend-api.
        const link = await db
            .from('telegram_user_links')
            .where('id', String(ctx.params.telegram_user_link))
            .first()
        if (!link) return ctx.response.status(404).send(fail('Data tidak ditemukan'))

        const access = await accessOf(ctx)
        if (!can(access, 'telegram.manage')) return forbidden(ctx)

        const target: LinkedUser | null =
            (await activeUsers().where('id', link.user_id).first()) ?? null
        if (!canManageStaffLink(access, target)) {
            return ctx.response.status(403).send(fail('Anda tidak berwenang menghapus tautan ini'))
        }

        await db.from('telegram_user_links').where('id', link.id).delete()

        return success('Tautan akun Telegram dihapus')
    }

    /**
     * Dipakai bot Telegram (role telegram_bot_service) untuk mengecek izin
     * SEBENARNYA pengirim pesan, bukan izin akun layanan bot itu sendiri --
     * tanpa ini siapa pun di grup yang terhubung ke bot bisa lock/unlock
     * device cuma karena bot punya izin itu.
     */
    async lookup(ctx: HttpContext) {
        // WAJIB dibatasi ke role telegram_bot_service -- route ini cuma butuh
        // login, jadi tanpa cek ini SIAPA PUN (termasuk staff_viewer) bisa
        // query role+permission+akses site staf LAIN lintas organisasi
        // (ditemukan lewat audit keamanan menyeluruh).
        const access = await accessOf(ctx)
        if (!hasRole(access, 'telegram_bot_service')) return forbidden(ctx)

        const telegramUserId = stringInput(ctx.request.input('telegram_user_id'))
        if (telegramUserId === '') {
            return ctx.response.status(422).send(fail('telegram_user_id wajib diisi'))
        }

        const link = await db
            .from('telegram_user_links')
            .where('telegram_user_id', telegramUserId)
            .first()
        if (!link) {
            return ctx.response
                .status(404)
                .send(fail('Akun Telegram ini belum ditautkan ke akun staf mana pun'))
        }

        const user = await activeUsers().where('id', link.user_id).first()
        // backend-api gagal 500 kalau user-nya sudah di-soft-delete; di sini
        // diperlakukan sama dengan akun nonaktif.
        if (!user || !user.is_active) {
            return ctx.response
                .status(403)
                .send(fail('Akun staf yang ditautkan sedang dinonaktifkan'))
        }

        const [roles, permissions, sites] = await Promise.all([
            roleNamesOf(user.id),
            permissionNamesOf(user.id),
            // siteAccess(): site yang sudah di-soft-delete tidak ikut.
            db
                .from('user_site_access')
                .join('organizations', 'organizations.id', 'user_site_access.organization_id')
                .where('user_site_access.user_id', user.id)
                .whereNull('organizations.deleted_at')
                .select('organizations.id'),
        ])

        return success('Tautan ditemukan', {
            id: user.id,
            name: user.name,
            username: user.username,
            organization_id: user.organization_id,
            roles,
            permissions,
            accessible_organization_ids: sites.map((site) => Number(site.id)),
        })
    }
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}
