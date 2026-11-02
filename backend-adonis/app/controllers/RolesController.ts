import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import {
    accessOf,
    can,
    hasRole,
    levelOfAccess,
    siteScopeOfAccess,
    type Access,
} from '#services/Access'
import { writeActivity } from '#services/ActivityLog'
import { fail, success } from '#services/ApiResponse'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { describePermission, GROUP_ORDER } from '#services/PermissionCatalog'
import { parseRoleList } from '#services/Permissions'
import {
    BUILT_IN_SCOPES,
    LEVEL_LOWEST,
    levelExceedsActor,
    LOCKED_ROLES,
    parseRoleInput,
    permissionsActorLacks,
    scopeExceedsActor,
    SENSITIVE_PERMISSIONS,
    SITE_SCOPES,
    type SiteScope,
} from '#services/RoleRules'

const ROLE_MORPH = 'Spatie\\Permission\\Models\\Role'

type RoleRow = {
    id: number
    name: string
    label: string | null
    description: string | null
    site_scope: SiteScope
    is_system: boolean
    level: number
    /** jsonb array nama peran; NULL = boleh menonton siaran semua peran. */
    watchable_roles: unknown
}

const ROLE_COLUMNS: string[] = [
    'id',
    'name',
    'label',
    'description',
    'site_scope',
    'is_system',
    'level',
    'watchable_roles',
]

/**
 * Menu Peran (Akses > Peran): membuat peran baru dan mengatur izin + cakupan site tiap peran.
 * Hanya pemegang izin roles.manage (super_admin). Perubahan berlaku di permintaan berikutnya
 * (izin dibaca dari database tiap request), tanpa login ulang.
 *
 * Pengaman: super_admin & akun layanan bot dikunci; pelaku tidak bisa memberikan izin atau
 * cakupan site yang tidak ia miliki sendiri, dan tidak bisa mengubah peran yang ia pegang
 * (kecuali super_admin); peran yang masih dipakai tidak bisa dihapus.
 */
export default class RolesController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'roles.manage')) return forbidden(ctx)

        const [roles, permissions] = await Promise.all([loadRoles(), loadPermissions()])
        return success('Daftar peran', {
            roles,
            permissions,
            site_scopes: SITE_SCOPES,
        })
    }

    /** Pilihan peran untuk form staf (pemegang users.manage atau roles.manage). */
    async options(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'roles.manage') && !can(access, 'users.manage')) return forbidden(ctx)

        const rows = (await db
            .from('roles')
            .where('guard_name', 'web')
            .whereNot('name', 'telegram_bot_service')
            .orderBy('id')
            .select(ROLE_COLUMNS)) as RoleRow[]

        return success(
            'Pilihan peran',
            rows.map((row) => ({
                name: row.name,
                label: row.label ?? row.name,
                description: row.description,
                site_scope: scopeOfRow(row),
                level: Number(row.level),
            }))
        )
    }

    async store(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'roles.manage')) return forbidden(ctx)

        const parsed = parseRoleInput(ctx.request.all(), true)
        if (!parsed.ok) return invalid(ctx, parsed.errors)
        const input = parsed.data
        const name = input.name!

        if (await db.from('roles').where({ name, guard_name: 'web' }).first()) {
            return invalid(ctx, { name: ['Kode peran sudah dipakai.'] })
        }

        const permissionIds = await checkGrant(
            ctx,
            access,
            [],
            null,
            input.permissions,
            input.siteScope
        )
        if (!permissionIds) return
        const level = input.level ?? LEVEL_LOWEST
        if (!checkLevel(ctx, access, null, level)) return
        if (!(await checkWatchableRoles(ctx, input.watchableRoles ?? null))) return

        const roleId = await db.transaction(async (trx) => {
            const now = new Date()
            const [created] = await trx
                .table('roles')
                .insert({
                    name,
                    guard_name: 'web',
                    label: input.label,
                    description: input.description,
                    site_scope: input.siteScope,
                    level,
                    watchable_roles: watchableColumn(input.watchableRoles ?? null),
                    is_system: false,
                    created_at: now,
                    updated_at: now,
                })
                .returning('id')
            const id = Number(typeof created === 'object' ? created.id : created)
            await replacePermissions(trx, id, permissionIds)
            return id
        })

        await writeActivity(ctx, {
            logName: 'default',
            description: 'Peran dibuat',
            event: 'created',
            subjectType: ROLE_MORPH,
            subjectId: roleId,
            organizationId: null,
            properties: {
                attributes: {
                    name,
                    label: input.label,
                    site_scope: input.siteScope,
                    level,
                    permissions: input.permissions,
                    watchable_roles: input.watchableRoles ?? null,
                },
            },
        })

        return ctx.response.status(201).send(success('Peran dibuat', await roleById(roleId)))
    }

    async update(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'roles.manage')) return forbidden(ctx)

        const role = await findRole(ctx.params.role)
        if (!role) return notFound(ctx)
        if (LOCKED_ROLES.includes(role.name)) return locked(ctx)
        // Mengubah peran sendiri = cara menaikkan hak sendiri; hanya super_admin yang dikecualikan.
        if (!hasRole(access, 'super_admin') && access.roles.includes(role.name)) {
            return ctx.response
                .status(403)
                .send(fail('Peran yang sedang Anda pegang tidak bisa Anda ubah sendiri'))
        }

        // Peran yang levelnya lebih tinggi dari pelaku tidak boleh diubah (anti naik pangkat).
        if (Number(role.level) < levelOfAccess(access)) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak bisa mengubah peran yang levelnya lebih tinggi dari Anda'))
        }

        const parsed = parseRoleInput(ctx.request.all(), false)
        if (!parsed.ok) return invalid(ctx, parsed.errors)
        const input = parsed.data

        const builtInScope = BUILT_IN_SCOPES[role.name]
        if (role.is_system && builtInScope && input.siteScope !== builtInScope) {
            return invalid(ctx, {
                site_scope: ['Cakupan site peran bawaan tidak bisa diubah.'],
            })
        }

        const before = await permissionNamesOfRole(role.id)
        const permissionIds = await checkGrant(
            ctx,
            access,
            before,
            scopeOfRow(role),
            input.permissions,
            input.siteScope
        )
        if (!permissionIds) return
        const level = input.level ?? Number(role.level)
        if (!checkLevel(ctx, access, Number(role.level), level)) return
        if (!(await checkWatchableRoles(ctx, input.watchableRoles ?? null))) return
        const watchable =
            input.watchableRoles === undefined ? watchableOfRow(role) : input.watchableRoles

        await db.transaction(async (trx) => {
            await trx
                .from('roles')
                .where('id', role.id)
                .update({
                    label: input.label,
                    description: input.description,
                    site_scope: input.siteScope,
                    level,
                    watchable_roles: watchableColumn(watchable),
                    updated_at: new Date(),
                })
            await replacePermissions(trx, role.id, permissionIds)
        })

        await writeActivity(ctx, {
            logName: 'default',
            description: 'Peran diperbarui',
            event: 'updated',
            subjectType: ROLE_MORPH,
            subjectId: role.id,
            organizationId: null,
            properties: {
                name: role.name,
                site_scope: { old: scopeOfRow(role), new: input.siteScope },
                level: { old: Number(role.level), new: level },
                watchable_roles: { old: watchableOfRow(role), new: watchable },
                permissions_added: input.permissions.filter((item) => !before.includes(item)),
                permissions_removed: before.filter((item) => !input.permissions.includes(item)),
            },
        })

        return success('Peran diperbarui', await roleById(role.id))
    }

    async destroy(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'roles.manage')) return forbidden(ctx)

        const role = await findRole(ctx.params.role)
        if (!role) return notFound(ctx)
        if (role.is_system || LOCKED_ROLES.includes(role.name)) return locked(ctx)
        if (Number(role.level) < levelOfAccess(access)) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak bisa menghapus peran yang levelnya lebih tinggi dari Anda'))
        }

        const users = await activeUserCount(role.id)
        if (users > 0) {
            return ctx.response
                .status(422)
                .send(
                    fail(`Peran masih dipakai ${users} staf. Pindahkan stafnya ke peran lain dulu.`)
                )
        }

        await db.transaction(async (trx) => {
            // Sisa tautan ke staf yang sudah dihapus (soft delete) ikut dibersihkan.
            await trx.from('model_has_roles').where('role_id', role.id).delete()
            await trx.from('role_has_permissions').where('role_id', role.id).delete()
            await trx.from('roles').where('id', role.id).delete()
        })

        await writeActivity(ctx, {
            logName: 'default',
            description: 'Peran dihapus',
            event: 'deleted',
            subjectType: ROLE_MORPH,
            subjectId: role.id,
            organizationId: null,
            properties: { name: role.name },
        })

        return success('Peran dihapus', null)
    }
}

/**
 * Cek bahwa pelaku boleh memberikan izin & cakupan ini. Mengembalikan id izin yang valid,
 * atau null kalau ditolak (respons error sudah dikirim). `current*` = kondisi peran sebelum
 * diubah (kosong/null saat membuat).
 */
async function checkGrant(
    ctx: HttpContext,
    access: Access,
    currentPermissions: string[],
    currentScope: SiteScope | null,
    requested: string[],
    scope: SiteScope
): Promise<number[] | null> {
    const rows = requested.length
        ? await db
              .from('permissions')
              .where('guard_name', 'web')
              .whereIn('name', requested)
              .select('id', 'name')
        : []
    const known = new Set(rows.map((row) => row.name as string))
    const unknown = requested.filter((item) => !known.has(item))
    if (unknown.length > 0) {
        invalid(ctx, { permissions: [`Izin tidak dikenal: ${unknown.join(', ')}`] })
        return null
    }

    // Izin pengelolaan akses (kelola staf/peran/site/keamanan) hanya milik Super Admin. Memberikannya
    // ke peran lain = pemegangnya bisa mengubah password / 2FA / peran Super Admin lalu mengambil alih.
    const sensitive = requested.filter(
        (item) => SENSITIVE_PERMISSIONS.includes(item) && !currentPermissions.includes(item)
    )
    if (sensitive.length > 0) {
        invalid(ctx, {
            permissions: [
                `Izin ini hanya untuk Super Admin dan tidak bisa diberikan ke peran lain: ${sensitive.join(', ')}`,
            ],
        })
        return null
    }

    const lacking = permissionsActorLacks(access.permissions, currentPermissions, requested)
    if (lacking.length > 0) {
        ctx.response
            .status(403)
            .send(
                fail(
                    `Anda tidak bisa memberikan izin yang tidak Anda miliki: ${lacking.join(', ')}`
                )
            )
        return null
    }
    if (scopeExceedsActor(siteScopeOfAccess(access), currentScope, scope)) {
        ctx.response
            .status(403)
            .send(fail('Anda tidak bisa memberikan cakupan site yang lebih luas dari milik Anda'))
        return null
    }

    return rows.map((row) => Number(row.id))
}

/** Level baru tidak boleh lebih tinggi dari level pelaku. Respons error sudah dikirim kalau gagal. */
function checkLevel(
    ctx: HttpContext,
    access: Access,
    currentLevel: number | null,
    requested: number
): boolean {
    if (!levelExceedsActor(levelOfAccess(access), currentLevel, requested)) return true
    ctx.response
        .status(403)
        .send(fail('Anda tidak bisa memberikan level yang lebih tinggi dari level Anda sendiri'))
    return false
}

async function replacePermissions(
    trx: TransactionClientContract,
    roleId: number,
    permissionIds: number[]
) {
    await trx.from('role_has_permissions').where('role_id', roleId).delete()
    if (permissionIds.length === 0) return
    await trx
        .table('role_has_permissions')
        .multiInsert(
            permissionIds.map((permissionId) => ({ role_id: roleId, permission_id: permissionId }))
        )
}

/** Peran bawaan memakai cakupan tetapnya, peran buatan sendiri memakai kolom site_scope. */
function scopeOfRow(row: Pick<RoleRow, 'name' | 'site_scope'>): SiteScope {
    return BUILT_IN_SCOPES[row.name] ?? row.site_scope
}

/** Hak tonton Live Kerja peran ini: null = semua peran. */
function watchableOfRow(row: Pick<RoleRow, 'watchable_roles'>): string[] | null {
    return row.watchable_roles === null || row.watchable_roles === undefined
        ? null
        : parseRoleList(row.watchable_roles)
}

/** Nilai kolom jsonb: null = semua peran. */
function watchableColumn(roles: string[] | null): string | null {
    return roles === null ? null : JSON.stringify(roles)
}

/** Semua peran di daftar "boleh ditonton" harus ada. Respons error sudah dikirim kalau gagal. */
async function checkWatchableRoles(ctx: HttpContext, roles: string[] | null): Promise<boolean> {
    if (!roles?.length) return true
    const rows = await db
        .from('roles')
        .where('guard_name', 'web')
        .whereIn('name', roles)
        .select('name')
    const known = new Set(rows.map((row) => row.name as string))
    const unknown = roles.filter((role) => !known.has(role))
    if (unknown.length > 0) {
        invalid(ctx, { watchable_roles: [`Peran tidak dikenal: ${unknown.join(', ')}`] })
        return false
    }
    return true
}

async function findRole(param: unknown): Promise<RoleRow | null> {
    const id = Number(param)
    if (!Number.isInteger(id) || id <= 0) return null
    const row = await db.from('roles').where({ id, guard_name: 'web' }).select(ROLE_COLUMNS).first()
    return (row as RoleRow | undefined) ?? null
}

async function permissionNamesOfRole(roleId: number): Promise<string[]> {
    const rows = await db
        .from('role_has_permissions')
        .join('permissions', 'permissions.id', 'role_has_permissions.permission_id')
        .where('role_has_permissions.role_id', roleId)
        .orderBy('permissions.id')
        .select('permissions.name')
    return rows.map((row) => row.name as string)
}

async function activeUserCount(roleId: number): Promise<number> {
    const [row] = await db
        .from('model_has_roles')
        .join('users', 'users.id', 'model_has_roles.model_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .where('model_has_roles.role_id', roleId)
        .whereNull('users.deleted_at')
        .count('* as total')
    return Number(row.total)
}

function shape(row: RoleRow, permissions: string[], users: number) {
    return {
        id: row.id,
        name: row.name,
        label: row.label ?? row.name,
        description: row.description,
        site_scope: scopeOfRow(row),
        level: Number(row.level),
        watchable_roles: watchableOfRow(row),
        is_system: row.is_system,
        locked: LOCKED_ROLES.includes(row.name),
        permissions,
        users_count: users,
    }
}

async function roleById(id: number) {
    const row = await findRole(id)
    return row ? shape(row, await permissionNamesOfRole(id), await activeUserCount(id)) : null
}

async function loadRoles() {
    const [rows, links, counts] = await Promise.all([
        db.from('roles').where('guard_name', 'web').orderBy('id').select(ROLE_COLUMNS),
        db
            .from('role_has_permissions')
            .join('permissions', 'permissions.id', 'role_has_permissions.permission_id')
            .orderBy('permissions.id')
            .select('role_has_permissions.role_id', 'permissions.name'),
        db
            .from('model_has_roles')
            .join('users', 'users.id', 'model_has_roles.model_id')
            .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
            .whereNull('users.deleted_at')
            .groupBy('model_has_roles.role_id')
            .select('model_has_roles.role_id')
            .count('* as total'),
    ])

    const permissionsOf = new Map<number, string[]>()
    for (const link of links) {
        const list = permissionsOf.get(Number(link.role_id)) ?? []
        list.push(link.name as string)
        permissionsOf.set(Number(link.role_id), list)
    }
    const usersOf = new Map(counts.map((row) => [Number(row.role_id), Number(row.total)]))

    return (rows as RoleRow[]).map((row) =>
        shape(row, permissionsOf.get(row.id) ?? [], usersOf.get(row.id) ?? 0)
    )
}

/** Semua izin yang ada, diurutkan per kelompok untuk matriks. */
async function loadPermissions() {
    const rows = await db
        .from('permissions')
        .where('guard_name', 'web')
        .orderBy('id')
        .select('name')
    return rows
        .map((row) => describePermission(row.name as string))
        .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}

function notFound(ctx: HttpContext) {
    return ctx.response.status(404).send(fail('Data tidak ditemukan'))
}

function locked(ctx: HttpContext) {
    return ctx.response
        .status(403)
        .send(fail('Peran bawaan ini dikunci dan tidak bisa diubah atau dihapus'))
}

function invalid(ctx: HttpContext, errors: Record<string, string[]>) {
    return ctx.response.status(422).send(fail('Data yang diberikan tidak valid.', errors))
}
