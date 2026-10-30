import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { accessOf, can, type Access } from '#services/access'
import { laravelDate, logModelEvent, WORK_SESSION_MORPH } from '#services/activity_log'
import { removeBroadcaster } from '#services/livekit'
import { hasGrantBasedAccess } from '#services/organization_scope'
import { closeSession, openSessionOf } from '#services/work_presence'
import { fail, success } from '#services/api_response'
import { hashLaravelPassword } from '#services/laravel/bcrypt'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import {
    findUser,
    freshUserResource,
    logUserChanges,
    logUserSnapshot,
    routeId,
    USER_COLUMNS,
    userResource,
    userResources,
    usersQuery,
    type UserRow,
} from '#services/user_resource'
import {
    laravelInput,
    laravelMessages,
    pageOf,
    perPageOf,
    requestInteger,
    storeUserInput,
    storeUserValidator,
    syncSiteAccessValidator,
    UPDATE_USER_SOMETIMES,
    updateUserValidator,
} from '#validators/users'

/**
 * Kelola staf yang bisa login ke web dashboard & APK master (permission
 * users.manage -- hari ini cuma dipegang super_admin). Padanan
 * UserController di backend-api, kontrak sama.
 *
 * Urutan cek sama dengan Laravel: staf di route dicari dulu (404), baru izin
 * (403), baru validasi (422).
 */
export default class UsersController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const manager = can(access, 'users.manage')
        // Admin & leader: hanya staf (peran staff_viewer) di site yang
        // dipegangnya -- cukup untuk menonaktifkan/mengaktifkan kembali.
        if (!manager && !hasGrantBasedAccess(access)) return forbidden(ctx)

        const input = laravelInput(ctx)
        const perPage = perPageOf(input, 20)
        const page = pageOf(input)
        const organizationId = requestInteger(input, 'organization_id')

        const filtered = () => {
            const query = usersQuery()
            if (organizationId) query.where('organization_id', organizationId)
            if (!manager) {
                query
                    .whereIn('organization_id', access.grantedOrganizationIds)
                    .whereIn('id', usersWithRoles([STAFF_ROLE]))
                    .whereNotIn('id', usersWithRolesExcept(STAFF_ROLE))
            }
            return query
        }

        const [countRow, rows] = await Promise.all([
            filtered().count('* as total').first(),
            filtered()
                .orderBy('name')
                .select(USER_COLUMNS)
                .offset((page - 1) * perPage)
                .limit(perPage),
        ])

        return success('Daftar staf', {
            items: await userResources(rows as UserRow[]),
            total: Number(countRow?.total ?? 0),
        })
    }

    async store(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await storeUserValidator.validate(storeUserInput(ctx.request.all()), {
            messagesProvider: laravelMessages,
        })
        const actorId = ctx.authUser!.id
        const password = await hashLaravelPassword(data.password)

        const userId = await db.transaction(async (trx) => {
            const now = new Date()
            const [created] = await trx
                .table('users')
                .insert({
                    name: data.name,
                    username: data.username,
                    email: data.email,
                    password,
                    organization_id: data.organization_id ?? null,
                    // Login pertama tetap memicu enrollment 2FA lewat
                    // AuthController, sama seperti akun lain.
                    is_active: true,
                    created_at: now,
                    updated_at: now,
                })
                .returning('id')
            const id = Number(typeof created === 'object' ? created.id : created)

            await assignRole(trx, id, data.role)

            if (data.site_access && data.site_access.length > 0) {
                await syncSites(trx, id, data.site_access, actorId)
            }
            return id
        })

        await logUserSnapshot(ctx, 'created', userId)

        return ctx.response
            .status(201)
            .send(success('Staf berhasil dibuat', await freshUserResource(userId)))
    }

    async show(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        return success('Detail staf', await userResource(user))
    }

    async update(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await updateUserValidator.validate(
            laravelInput(ctx, { sometimes: UPDATE_USER_SOMETIMES }),
            { messagesProvider: laravelMessages, meta: { userId: user.id } }
        )

        // array_filter(): nilai null dibuang, jadi organization_id tidak bisa
        // dikosongkan lewat endpoint ini (sama seperti backend-api).
        const changes: Record<string, unknown> = {}
        if (data.name !== undefined) changes.name = data.name
        if (data.email !== undefined) changes.email = data.email
        if (data.organization_id !== undefined && data.organization_id !== null) {
            changes.organization_id = data.organization_id
        }
        if (data.password !== undefined) {
            changes.password = await hashLaravelPassword(data.password)
        }

        // Eloquent hanya menyimpan (dan menggeser updated_at) kalau ada yang
        // berubah; password baru selalu dianggap berubah (hash baru).
        const dirty = Object.entries(changes).filter(
            ([key, value]) => key === 'password' || (user as Record<string, unknown>)[key] !== value
        )

        await db.transaction(async (trx) => {
            if (dirty.length > 0) {
                await trx
                    .from('users')
                    .where('id', user.id)
                    .update({ ...Object.fromEntries(dirty), updated_at: new Date() })
            }
            if (data.role !== undefined) {
                // syncRoles(): lepas semua peran lalu pasang yang baru.
                await trx
                    .from('model_has_roles')
                    .where('model_type', LARAVEL_USER_MORPH)
                    .where('model_id', user.id)
                    .delete()
                await assignRole(trx, user.id, data.role)
            }
        })

        await logUserChanges(
            ctx,
            user,
            Object.fromEntries(dirty),
            (changes.organization_id as number | undefined) ?? user.organization_id
        )

        return success('Staf berhasil diperbarui', await freshUserResource(user.id))
    }

    async destroy(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        if (user.id === ctx.authUser!.id) {
            return ctx.response.status(422).send(fail('Tidak bisa menghapus akun sendiri'))
        }

        // Soft delete (SoftDeletes): deleted_at & updated_at diisi.
        const now = new Date()
        await db.from('users').where('id', user.id).update({ deleted_at: now, updated_at: now })
        await logUserSnapshot(ctx, 'deleted', user.id)
        // Staf yang dihapus juga langsung keluar dari Live Kerja & socket-nya
        // (gateway memutus socket begitu tokennya hilang).
        await db.transaction((trx) => deleteTokens(trx, user.id))
        await endLiveWork(ctx, user.id, 'deleted')

        return success('Staf berhasil dihapus')
    }

    async suspend(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canChangeStatus(await accessOf(ctx), user))) return forbidden(ctx)

        if (user.id === ctx.authUser!.id) {
            return ctx.response.status(422).send(fail('Tidak bisa men-suspend akun sendiri'))
        }

        await db.transaction(async (trx) => {
            if (user.is_active !== false) {
                await trx
                    .from('users')
                    .where('id', user.id)
                    .update({ is_active: false, updated_at: new Date() })
            }
            // Semua sesi login dicabut supaya staf langsung keluar.
            await deleteTokens(trx, user.id)
        })
        await logUserChanges(ctx, user, { is_active: false }, user.organization_id)
        // Langsung putus juga dari Live Kerja: sesi kerja ditutup & dikeluarkan
        // dari room LiveKit. Socket dashboard/APK-nya diputus gateway begitu
        // tokennya hilang (realtime-gateway, cek token berkala).
        await endLiveWork(ctx, user.id, 'suspended')

        return success('Staf disuspen — semua sesi login dicabut', await freshUserResource(user.id))
    }

    async reactivate(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canChangeStatus(await accessOf(ctx), user))) return forbidden(ctx)

        if (user.is_active !== true) {
            await db
                .from('users')
                .where('id', user.id)
                .update({ is_active: true, updated_at: new Date() })
            await logUserChanges(ctx, user, { is_active: true }, user.organization_id)
        }

        return success('Staf diaktifkan kembali', await freshUserResource(user.id))
    }

    /**
     * Reset 2FA staf (HP authenticator-nya hilang/ganti) -- secret & recovery
     * codes dikosongkan supaya login berikutnya memicu setup 2FA dari awal
     * (QR code baru). Sesi login yang aktif ikut dicabut supaya device lama
     * tidak bisa dipakai lagi tanpa setup ulang -- konsisten dengan suspend().
     */
    async reset2fa(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        await db.transaction(async (trx) => {
            const current = await trx
                .from('users')
                .where('id', user.id)
                .select('two_factor_secret', 'two_factor_recovery_codes', 'two_factor_confirmed_at')
                .first()
            const dirty =
                current &&
                (current.two_factor_secret !== null ||
                    current.two_factor_recovery_codes !== null ||
                    current.two_factor_confirmed_at !== null)
            if (dirty) {
                await trx.from('users').where('id', user.id).update({
                    two_factor_secret: null,
                    two_factor_recovery_codes: null,
                    two_factor_confirmed_at: null,
                    updated_at: new Date(),
                })
            }
            await deleteTokens(trx, user.id)
        })
        // Kolom 2FA tidak termasuk logOnly User, jadi tidak ada log model.

        return success(
            `2FA ${user.name} direset — login berikutnya akan diminta setup ulang`,
            await freshUserResource(user.id)
        )
    }

    /** Atur site mana saja yang boleh dilihat user dengan role admin/leader. */
    async syncSiteAccess(ctx: HttpContext) {
        const user = await findUser(routeId(ctx.params.user))
        if (!user) return notFound(ctx)
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await syncSiteAccessValidator.validate(
            laravelInput(ctx, { requiredArrays: ['organization_ids'] }),
            { messagesProvider: laravelMessages }
        )

        await db.transaction((trx) =>
            syncSites(trx, user.id, data.organization_ids, ctx.authUser!.id)
        )

        return success('Akses site diperbarui', await freshUserResource(user.id))
    }
}

async function canManage(ctx: HttpContext) {
    return can(await accessOf(ctx), 'users.manage')
}

const STAFF_ROLE = 'staff_viewer'

/** id user yang punya salah satu peran ini (subquery). */
function usersWithRoles(roles: string[]) {
    return db
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .whereIn('roles.name', roles)
        .select('model_has_roles.model_id')
}

/** id user yang punya peran SELAIN peran ini (subquery). */
function usersWithRolesExcept(role: string) {
    return db
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .whereNot('roles.name', role)
        .select('model_has_roles.model_id')
}

/**
 * Menonaktifkan / mengaktifkan kembali: super_admin (users.manage) siapa pun;
 * admin & leader hanya staf biasa (peran staff_viewer saja) di site yang
 * diberikan kepadanya -- tidak bisa menyentuh admin, leader, atau root.
 */
async function canChangeStatus(access: Access, user: UserRow): Promise<boolean> {
    if (can(access, 'users.manage')) return true
    if (!hasGrantBasedAccess(access)) return false
    if (
        user.organization_id === null ||
        !access.grantedOrganizationIds.includes(user.organization_id)
    ) {
        return false
    }
    const roles = await db
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .where('model_has_roles.model_id', user.id)
        .select('roles.name')
    return roles.length > 0 && roles.every((role) => role.name === STAFF_ROLE)
}

/** Tutup sesi Live Kerja yang masih terbuka & keluarkan dari room LiveKit. */
async function endLiveWork(ctx: HttpContext, userId: number, reason: string) {
    const session = await openSessionOf(userId)
    if (!session) return
    await closeSession(session, reason, 'work_end')
    await logModelEvent(ctx, {
        event: 'updated',
        subjectType: WORK_SESSION_MORPH,
        subjectId: session.id,
        organizationId: session.organization_id,
        attributes: { ended_at: laravelDate(session.ended_at), end_reason: reason },
        old: { ended_at: null, end_reason: null },
    })
    await removeBroadcaster(session.organization_id, userId)
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}

function notFound(ctx: HttpContext) {
    return ctx.response.status(404).send(fail('Data tidak ditemukan'))
}

/** assignRole() spatie: peran guard 'web'; nama yang tidak ada = error server. */
async function assignRole(trx: TransactionClientContract, userId: number, roleName: string) {
    const role = await trx
        .from('roles')
        .where('name', roleName)
        .where('guard_name', 'web')
        .select('id')
        .first()
    if (!role) {
        throw new Error(`Role "${roleName}" tidak ada untuk guard web`)
    }
    await trx
        .table('model_has_roles')
        .insert({ role_id: role.id, model_type: LARAVEL_USER_MORPH, model_id: userId })
        .onConflict(['role_id', 'model_id', 'model_type'])
        .ignore()
}

/** $user->tokens()->delete(): cabut semua token Sanctum staf ini. */
async function deleteTokens(trx: TransactionClientContract, userId: number) {
    await trx
        .from('personal_access_tokens')
        .where('tokenable_type', LARAVEL_USER_MORPH)
        .where('tokenable_id', userId)
        .delete()
}

/**
 * siteAccess()->sync([...] dengan granted_by): site yang tidak disebut
 * dilepas, site baru ditambahkan, site yang sudah ada diperbarui granted_by
 * & updated_at-nya (updateExistingPivot).
 */
async function syncSites(
    trx: TransactionClientContract,
    userId: number,
    organizationIds: number[],
    grantedBy: number
) {
    const wanted = [...new Set(organizationIds)]
    const now = new Date()

    const removed = trx.from('user_site_access').where('user_id', userId)
    if (wanted.length > 0) removed.whereNotIn('organization_id', wanted)
    await removed.delete()

    if (wanted.length === 0) return

    const existing = await trx
        .from('user_site_access')
        .where('user_id', userId)
        .whereIn('organization_id', wanted)
        .select('organization_id')
    const existingIds = new Set(existing.map((row) => Number(row.organization_id)))

    if (existingIds.size > 0) {
        await trx
            .from('user_site_access')
            .where('user_id', userId)
            .whereIn('organization_id', [...existingIds])
            .update({ granted_by: grantedBy, updated_at: now })
    }

    const added = wanted.filter((id) => !existingIds.has(id))
    if (added.length > 0) {
        await trx.table('user_site_access').multiInsert(
            added.map((organizationId) => ({
                user_id: userId,
                organization_id: organizationId,
                granted_by: grantedBy,
                created_at: now,
                updated_at: now,
            }))
        )
    }
}
