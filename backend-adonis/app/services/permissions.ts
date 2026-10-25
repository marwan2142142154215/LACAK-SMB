import db from '@adonisjs/lucid/services/db'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

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

export async function hasPermission(userId: number, permission: string): Promise<boolean> {
    const permissions = await permissionNamesOf(userId)
    return permissions.includes(permission)
}
