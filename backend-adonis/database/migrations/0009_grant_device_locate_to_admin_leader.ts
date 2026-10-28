import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Admin & leader boleh meminta lokasi device sekarang (tombol "Minta Lokasi
 * Sekarang" di APK SMB Admin) untuk site yang dipegangnya, melengkapi izin
 * kunci & geofence dari migrasi 0008. Staf tetap tidak bisa.
 * Database baru: peran belum ada di sini dan dibuat lengkap oleh db:seed.
 */
const ROLES = ['admin', 'leader']
const PERMISSIONS = ['devices.locate']

export default class extends BaseSchema {
    async up() {
        this.defer(async (db) => {
            const permissions = await db
                .from('permissions')
                .where('guard_name', 'web')
                .whereIn('name', PERMISSIONS)
                .select('id')
            const roles = await db
                .from('roles')
                .where('guard_name', 'web')
                .whereIn('name', ROLES)
                .select('id')
            for (const role of roles) {
                for (const permission of permissions) {
                    await db
                        .table('role_has_permissions')
                        .insert({ role_id: role.id, permission_id: permission.id })
                        .onConflict(['permission_id', 'role_id'])
                        .ignore()
                }
            }
        })
    }

    async down() {
        this.defer(async (db) => {
            const permissionIds = db
                .from('permissions')
                .where('guard_name', 'web')
                .whereIn('name', PERMISSIONS)
                .select('id')
            const roleIds = db
                .from('roles')
                .where('guard_name', 'web')
                .whereIn('name', ROLES)
                .select('id')
            await db
                .from('role_has_permissions')
                .whereIn('permission_id', permissionIds)
                .whereIn('role_id', roleIds)
                .delete()
        })
    }
}
