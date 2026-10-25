import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'

/**
 * Persiapan bersama tes fungsional (dipasang di tests/bootstrap.ts).
 *
 * Database tes juga dipakai tes Laravel, yang mengosongkannya ulang setiap
 * kali jalan -- jadi peran & izin dibuat di sini, sama persis dengan
 * RolesAndPermissionsSeeder backend-api (ubah keduanya bersamaan).
 */
const PERMISSIONS = [
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
    'live.broadcast',
    'live.watch',
    'security.manage',
]

const ROLE_PERMISSIONS: Record<string, string[]> = {
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
    admin: ['devices.view', 'live.watch'],
    leader: ['devices.view', 'live.watch'],
    staff_viewer: ['devices.view', 'live.broadcast', 'live.watch'],
    telegram_bot_service: [
        'devices.view',
        'devices.lock',
        'devices.unlock',
        'devices.locate',
        'devices.monitor',
        'apk-builds.manage',
    ],
}

async function idOf(table: 'roles' | 'permissions', name: string): Promise<number> {
    const existing = await db.from(table).where({ name, guard_name: 'web' }).first()
    if (existing) return existing.id
    const now = new Date()
    const [row] = await db
        .table(table)
        .insert({ name, guard_name: 'web', created_at: now, updated_at: now })
        .returning('id')
    return row.id
}

/** Padanan RolesAndPermissionsSeeder: firstOrCreate + syncPermissions. */
export async function seedRolesAndPermissions() {
    const permissionIds = new Map<string, number>()
    for (const name of PERMISSIONS) {
        permissionIds.set(name, await idOf('permissions', name))
    }

    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
        const roleId = await idOf('roles', role)
        await db.from('role_has_permissions').where('role_id', roleId).delete()
        await db.table('role_has_permissions').multiInsert(
            permissions.map((name) => ({
                role_id: roleId,
                permission_id: permissionIds.get(name)!,
            }))
        )
    }
}

/**
 * Hapus semua kunci Redis milik aplikasi ini (penghitung rate limit, token
 * 2FA, cache overview) -- setara cache "array" Laravel yang kosong di tiap
 * tes. Hanya kunci berawalan keyPrefix aplikasi ini (config/redis.ts) yang
 * dihapus: Redis lokal bisa saja dipakai proyek lain.
 */
export async function clearAppRedisKeys() {
    const raw = redis.connection('queue')
    const prefix = 'lacak-adonis:'
    let cursor = '0'
    do {
        const [next, keys] = await raw.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500)
        cursor = next
        if (keys.length) await raw.del(...keys)
    } while (cursor !== '0')
}
