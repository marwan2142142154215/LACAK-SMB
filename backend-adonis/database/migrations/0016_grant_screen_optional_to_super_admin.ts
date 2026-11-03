import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Super Admin memegang semua izin (sama seperti migrasi 0008 & 0011). Migrasi 0014 hanya membuat
 * izin live.screen-optional dan tidak memberikannya ke siapa pun, sehingga Super Admin ditolak saat
 * mencentangnya untuk peran lain ("tidak bisa memberikan izin yang tidak Anda miliki").
 * Aman dijalankan berulang (ON CONFLICT DO NOTHING).
 */
const PERMISSION = 'live.screen-optional'

export default class extends BaseSchema {
    async up() {
        this.defer(async (db) => {
            await db.rawQuery(
                `INSERT INTO role_has_permissions (permission_id, role_id)
                 SELECT p.id, r.id FROM permissions p, roles r
                  WHERE p.name = ? AND p.guard_name = 'web'
                    AND r.name = 'super_admin' AND r.guard_name = 'web'
                 ON CONFLICT DO NOTHING`,
                [PERMISSION]
            )
        })
    }

    async down() {
        this.defer(async (db) => {
            await db.rawQuery(
                `DELETE FROM role_has_permissions
                  WHERE permission_id IN (
                        SELECT id FROM permissions WHERE name = ? AND guard_name = 'web')
                    AND role_id IN (
                        SELECT id FROM roles WHERE name = 'super_admin' AND guard_name = 'web')`,
                [PERMISSION]
            )
        })
    }
}
