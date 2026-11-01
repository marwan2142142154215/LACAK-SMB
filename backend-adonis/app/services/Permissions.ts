import db from '@adonisjs/lucid/services/db'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { BUILT_IN_SCOPES, widestScope, type SiteScope } from '#services/RoleRules'

/**
 * Peran & izin dari tabel spatie/laravel-permission milik backend-api
 * (roles, permissions, model_has_roles, model_has_permissions,
 * role_has_permissions). Hanya guard 'web', satu-satunya yang dipakai.
 */
export async function roleNamesOf(userId: number): Promise<string[]> {
    const rows = await db
        .from('roles')
        .join('model_has_roles', 'model_has_roles.role_id', 'roles.id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .where('model_has_roles.model_id', userId)
        .orderBy('roles.id')
        .select('roles.name')

    return rows.map((row) => row.name)
}

/** Sama dengan getAllPermissions(): izin langsung + izin dari semua perannya. */
export async function permissionNamesOf(userId: number): Promise<string[]> {
    const direct = db
        .from('model_has_permissions')
        .where('model_type', LARAVEL_USER_MORPH)
        .where('model_id', userId)
        .select('permission_id')

    const viaRoles = db
        .from('role_has_permissions')
        .join('model_has_roles', 'model_has_roles.role_id', 'role_has_permissions.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .where('model_has_roles.model_id', userId)
        .select('role_has_permissions.permission_id')

    const rows = await db
        .from('permissions')
        .where((query) => query.whereIn('id', direct).orWhereIn('id', viaRoles))
        .orderBy('id')
        .select('name')

    return rows.map((row) => row.name)
}

/**
 * Cakupan site user = yang terluas dari semua perannya. Peran bawaan memakai cakupan
 * tetapnya (BUILT_IN_SCOPES); peran buatan sendiri memakai roles.site_scope.
 */
export async function siteScopeOf(userId: number): Promise<SiteScope> {
    const rows = await db
        .from('roles')
        .join('model_has_roles', 'model_has_roles.role_id', 'roles.id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .where('model_has_roles.model_id', userId)
        .select('roles.name', 'roles.site_scope')

    return widestScope(
        rows.map((row) => BUILT_IN_SCOPES[row.name] ?? (row.site_scope as SiteScope))
    )
}

/**
 * Peran penyiar yang boleh ditonton user ini (gabungan roles.watchable_roles semua perannya).
 * null = semua peran: salah satu perannya tidak membatasi (kolom NULL, bawaan).
 */
export async function watchRolesOf(userId: number): Promise<string[] | null> {
    const rows = await db
        .from('roles')
        .join('model_has_roles', 'model_has_roles.role_id', 'roles.id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .where('model_has_roles.model_id', userId)
        .select('roles.watchable_roles')

    if (rows.some((row) => row.watchable_roles === null)) return null
    return [...new Set(rows.flatMap((row) => parseRoleList(row.watchable_roles)))]
}

/**
 * Peran tempat siaran tiap user dicatat: peran pertamanya (urutan id peran).
 * User tanpa peran tidak masuk peta.
 */
export async function liveRolesOf(userIds: number[]): Promise<Map<number, string>> {
    if (!userIds.length) return new Map()
    const rows = await db
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .whereIn('model_has_roles.model_id', userIds)
        .orderBy('roles.id')
        .select('model_has_roles.model_id', 'roles.name')

    const roles = new Map<number, string>()
    for (const row of rows) {
        const userId = Number(row.model_id)
        if (!roles.has(userId)) roles.set(userId, row.name)
    }
    return roles
}

/** Kolom jsonb (array nama peran) -> string[]; nilai rusak dianggap kosong. */
export function parseRoleList(value: unknown): string[] {
    const list = typeof value === 'string' ? safeJson(value) : value
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []
}

function safeJson(value: string): unknown {
    try {
        return JSON.parse(value)
    } catch {
        return null
    }
}

export async function hasPermission(userId: number, permission: string): Promise<boolean> {
    const permissions = await permissionNamesOf(userId)
    return permissions.includes(permission)
}
