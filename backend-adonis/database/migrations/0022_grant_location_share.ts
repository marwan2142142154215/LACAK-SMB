import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Izin `location.share` ("Bagikan lokasi sendiri"): user pemegang izin ini
 * melaporkan lokasinya lewat APK / aplikasi desktop selama login & bekerja, lalu
 * terlihat oleh pengawas di peta Radar. Diberikan ke peran bawaan `staff_viewer`;
 * peran lain diatur dari menu Akses -> Peran. Aman dijalankan berulang (ON CONFLICT
 * DO NOTHING). Pola sama dengan 0017/0020.
 */
const PERMISSION = 'location.share'
const GRANTED_ROLES = ['staff_viewer']

export default class extends BaseSchema {
    async up() {
        this.defer(async (db) => {
            const now = new Date()
            await db
                .table('permissions')
                .insert({ name: PERMISSION, guard_name: 'web', created_at: now, updated_at: now })
                .onConflict(['name', 'guard_name'])
                .ignore()

            for (const role of GRANTED_ROLES) {
                await db.rawQuery(
                    `INSERT INTO role_has_permissions (permission_id, role_id)
                     SELECT p.id, r.id FROM permissions p, roles r
                      WHERE p.name = ? AND p.guard_name = 'web'
                        AND r.name = ? AND r.guard_name = 'web'
                     ON CONFLICT DO NOTHING`,
                    [PERMISSION, role]
                )
            }
        })
    }

    async down() {
        this.defer(async (db) => {
            await db.rawQuery(
                `DELETE FROM role_has_permissions
                  WHERE permission_id IN (
                    SELECT id FROM permissions WHERE name = ? AND guard_name = 'web'
                  )`,
                [PERMISSION]
            )
            await db.from('permissions').where({ name: PERMISSION, guard_name: 'web' }).delete()
        })
    }
}
