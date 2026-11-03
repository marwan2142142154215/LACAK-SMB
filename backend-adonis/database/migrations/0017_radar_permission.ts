import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Izin radar.view ("Lihat radar & lokasi"): halaman Radar dan semua data lokasi device (koordinat,
 * jarak BLE, peta) dikunci ke izin ini -- dulu cukup devices.view, yang juga dipegang peran
 * staff_viewer bawaan. Yang diberi izin ini hanya peran bawaan pengelola device (super_admin, admin,
 * site_admin, leader); staff_viewer dan peran buatan sendiri TIDAK, lalu diatur dari menu Peran.
 * Aman dijalankan berulang (ON CONFLICT DO NOTHING).
 */
const PERMISSION = 'radar.view'
const GRANTED_ROLES = ['super_admin', 'admin', 'site_admin', 'leader']

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
