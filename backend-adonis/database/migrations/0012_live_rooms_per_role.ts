import { BaseSchema } from '@adonisjs/lucid/schema'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

/**
 * Live Kerja untuk semua peran + hak tonton per peran.
 *
 * - roles.watchable_roles: peran penyiar yang boleh ditonton peran ini (jsonb
 *   array nama peran). NULL = semua peran -- nilai awal semua peran, jadi
 *   perilaku lama tidak berubah sampai diatur di menu Peran.
 * - work_sessions.live_role: peran tempat siaran dicatat; room LiveKit kini
 *   site-{id}-{peran} / pusat-{peran}. Sesi lama diisi peran pertama user-nya.
 * - Izin live.watch-central (Ruang pusat, dulu "ruang leader" yang dikunci ke
 *   admin & root) diberikan ke super_admin & admin.
 * - Leader kini siaran lewat izin live.broadcast (dulu dikunci ke nama peran).
 *
 * Aman dijalankan berulang.
 */
const GRANTS: Array<[string, string]> = [
    ['live.watch-central', 'super_admin'],
    ['live.watch-central', 'admin'],
    ['live.broadcast', 'leader'],
]

export default class extends BaseSchema {
    async up() {
        this.schema.raw(`
            ALTER TABLE roles ADD COLUMN IF NOT EXISTS watchable_roles jsonb NULL;
            ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS live_role varchar(40) NULL;
        `)

        this.defer(async (db) => {
            await db.rawQuery(
                `UPDATE work_sessions ws
                    SET live_role = first_role.name
                   FROM (
                        SELECT DISTINCT ON (mhr.model_id) mhr.model_id, r.name
                          FROM model_has_roles mhr
                          JOIN roles r ON r.id = mhr.role_id
                         WHERE mhr.model_type = ?
                         ORDER BY mhr.model_id, r.id
                   ) first_role
                  WHERE first_role.model_id = ws.user_id
                    AND ws.live_role IS NULL`,
                [LARAVEL_USER_MORPH]
            )
            await db.rawQuery(
                `UPDATE work_sessions SET live_role = 'lainnya' WHERE live_role IS NULL`
            )

            const now = new Date()
            await db
                .table('permissions')
                .insert({
                    name: 'live.watch-central',
                    guard_name: 'web',
                    created_at: now,
                    updated_at: now,
                })
                .onConflict(['name', 'guard_name'])
                .ignore()

            for (const [permission, role] of GRANTS) {
                await db.rawQuery(
                    `INSERT INTO role_has_permissions (permission_id, role_id)
                     SELECT p.id, r.id FROM permissions p, roles r
                      WHERE p.name = ? AND p.guard_name = 'web'
                        AND r.name = ? AND r.guard_name = 'web'
                     ON CONFLICT DO NOTHING`,
                    [permission, role]
                )
            }
        })
    }

    async down() {
        this.defer(async (db) => {
            await db.rawQuery(
                `DELETE FROM role_has_permissions
                  WHERE permission_id IN (
                    SELECT id FROM permissions WHERE name = 'live.watch-central' AND guard_name = 'web'
                  )`
            )
            await db
                .from('permissions')
                .where({ name: 'live.watch-central', guard_name: 'web' })
                .delete()
            // live.broadcast leader tidak dicabut: bisa saja sudah diatur dari menu Peran.
        })
        this.schema.raw(`
            ALTER TABLE roles DROP COLUMN IF EXISTS watchable_roles;
            ALTER TABLE work_sessions DROP COLUMN IF EXISTS live_role;
        `)
    }
}
