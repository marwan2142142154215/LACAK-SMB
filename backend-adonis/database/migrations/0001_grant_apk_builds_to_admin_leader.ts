import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Admin & leader boleh build dan mengunduh APK untuk site yang dipegangnya
 * (sebelumnya hanya root & admin site). Staf tetap tidak bisa.
 * Database baru: peran belum ada di sini dan dibuat lengkap oleh db:seed.
 */
const ROLES = ['admin', 'leader']
const PERMISSION = 'apk-builds.manage'

export default class extends BaseSchema {
    async up() {
        this.defer(async (db) => {
            const permission = await db
                .from('permissions')
                .where({ name: PERMISSION, guard_name: 'web' })
                .first()
            if (!permission) return

            const roles = await db
                .from('roles')
                .where('guard_name', 'web')
                .whereIn('name', ROLES)
                .select('id')
            for (const role of roles) {
                const exists = await db
                    .from('role_has_permissions')
                    .where({ role_id: role.id, permission_id: permission.id })
                    .first()
                if (!exists) {
                    await db
                        .table('role_has_permissions')
                        .insert({ role_id: role.id, permission_id: permission.id })
                }
            }
        })
    }

    async down() {
        this.defer(async (db) => {
            const permission = await db
                .from('permissions')
                .where({ name: PERMISSION, guard_name: 'web' })
                .first()
            if (!permission) return
            const roleIds = db
                .from('roles')
                .where('guard_name', 'web')
                .whereIn('name', ROLES)
                .select('id')
            await db
                .from('role_has_permissions')
                .where('permission_id', permission.id)
                .whereIn('role_id', roleIds)
                .delete()
        })
    }
}
