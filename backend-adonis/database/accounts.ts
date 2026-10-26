import { randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

/**
 * Peran, izin, dan akun bawaan sistem (padanan seeder Laravel lama).
 * Dipakai database/seeders/main_seeder.ts, command demo:seed-accounts, dan
 * persiapan tes fungsional.
 */
export const PERMISSIONS = [
    'organizations.manage',
    'users.manage',
    'devices.view',
    'devices.manage',
    'devices.lock',
    'devices.unlock',
    'devices.locate',
    'devices.monitor',
    'consent-documents.manage',
    'geofence-rules.manage',
    'apk-builds.manage',
    'telegram.manage',
    'activity-logs.view',
    // Live Kerja: broadcast = boleh "Mulai Kerja" & menyiarkan kamera,
    // watch = boleh menonton siaran site yang memang boleh diakses.
    'live.broadcast',
    'live.watch',
    // Pengaturan keamanan sistem (mis. wajib/tidaknya 2FA) -- hanya super_admin.
    'security.manage',
]

export const ROLE_PERMISSIONS: Record<string, string[]> = {
    super_admin: PERMISSIONS,
    site_admin: [
        'devices.view',
        'devices.manage',
        'devices.lock',
        'devices.unlock',
        'devices.locate',
        'devices.monitor',
        'consent-documents.manage',
        'geofence-rules.manage',
        'apk-builds.manage',
        'telegram.manage',
        'activity-logs.view',
        'live.broadcast',
        'live.watch',
    ],
    // admin & leader: lintas site lewat user_site_access; melihat, plus
    // build & unduh APK untuk site yang dipegang.
    admin: ['devices.view', 'live.watch', 'apk-builds.manage'],
    leader: ['devices.view', 'live.watch', 'apk-builds.manage'],
    staff_viewer: ['devices.view', 'live.broadcast', 'live.watch'],
    // Akun layanan bot Telegram: kendali device + build APK, tanpa pengaturan site.
    telegram_bot_service: [
        'devices.view',
        'devices.lock',
        'devices.unlock',
        'devices.locate',
        'devices.monitor',
        'apk-builds.manage',
    ],
}

async function idOf(
    client: QueryClientContract,
    table: 'roles' | 'permissions',
    name: string
): Promise<number> {
    const existing = await client.from(table).where({ name, guard_name: 'web' }).first()
    if (existing) return existing.id
    const now = new Date()
    const [row] = await client
        .table(table)
        .insert({ name, guard_name: 'web', created_at: now, updated_at: now })
        .returning('id')
    return row.id
}

/** Buat peran & izin yang belum ada, lalu samakan izin tiap peran. */
export async function seedRolesAndPermissions(client: QueryClientContract = db.connection()) {
    const permissionIds = new Map<string, number>()
    for (const name of PERMISSIONS) {
        permissionIds.set(name, await idOf(client, 'permissions', name))
    }

    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
        const roleId = await idOf(client, 'roles', role)
        await client.from('role_has_permissions').where('role_id', roleId).delete()
        await client.table('role_has_permissions').multiInsert(
            permissions.map((name) => ({
                role_id: roleId,
                permission_id: permissionIds.get(name)!,
            }))
        )
    }
}

/** Ganti semua peran user dengan satu daftar peran. */
export async function syncRoles(client: QueryClientContract, userId: number, roles: string[]) {
    await client
        .from('model_has_roles')
        .where({ model_type: LARAVEL_USER_MORPH, model_id: userId })
        .delete()
    if (!roles.length) return
    const ids = await client
        .from('roles')
        .where('guard_name', 'web')
        .whereIn('name', roles)
        .select('id')
    await client.table('model_has_roles').multiInsert(
        ids.map((row) => ({
            role_id: row.id,
            model_type: LARAVEL_USER_MORPH,
            model_id: userId,
        }))
    )
}

/** Ganti daftar site yang boleh diakses admin/leader. */
export async function syncSiteAccess(
    client: QueryClientContract,
    userId: number,
    organizationIds: number[]
) {
    await client.from('user_site_access').where('user_id', userId).delete()
    if (!organizationIds.length) return
    const now = new Date()
    await client.table('user_site_access').multiInsert(
        organizationIds.map((organizationId) => ({
            user_id: userId,
            organization_id: organizationId,
            created_at: now,
            updated_at: now,
        }))
    )
}

/** Password acak untuk akun yang passwordnya tidak diisi lewat env. */
export function randomPassword(length = 20): string {
    return randomBytes(length * 2)
        .toString('base64')
        .replace(/[/+=]/g, '')
        .slice(0, length)
}
