import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Menu Peran (Akses > Peran): tabel `roles` (spatie) diberi nama tampilan, deskripsi,
 * cakupan site, dan penanda peran bawaan. Peran buatan sendiri (mis. "audit") otomatis
 * berlaku untuk site sendiri sampai diatur di menu Peran. Izin baru `roles.manage`
 * dipasang ke super_admin. Aman dijalankan di database yang sudah berisi peran.
 */
const BUILT_IN = [
    ['super_admin', 'Super Admin', 'Full akses semua fitur & semua site', 'all'],
    ['site_admin', 'Site Admin', 'Kelola site sendiri penuh', 'own'],
    ['admin', 'Admin', 'Lihat site yang diizinkan', 'granted'],
    ['leader', 'Leader', 'Lihat site yang diizinkan', 'granted'],
    ['staff_viewer', 'Staff Viewer', 'Lihat site sendiri', 'own'],
    ['telegram_bot_service', 'Telegram Bot Service', 'Akun layanan bot Telegram', 'own'],
] as const

export default class extends BaseSchema {
    protected tableName = 'roles'

    async up() {
        this.schema.raw(`
            ALTER TABLE roles
                ADD COLUMN IF NOT EXISTS label varchar(100) NULL,
                ADD COLUMN IF NOT EXISTS description varchar(255) NULL,
                ADD COLUMN IF NOT EXISTS site_scope varchar(10) NOT NULL DEFAULT 'own'
                    CHECK (site_scope IN ('all', 'granted', 'own')),
                ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false
        `)

        this.defer(async (db) => {
            for (const [name, label, description, scope] of BUILT_IN) {
                await db.rawQuery(
                    `UPDATE roles
                        SET is_system = true,
                            site_scope = ?,
                            label = COALESCE(label, ?),
                            description = COALESCE(description, ?)
                      WHERE name = ? AND guard_name = 'web'`,
                    [scope, label, description, name]
                )
            }

            const now = new Date()
            await db
                .table('permissions')
                .insert({
                    name: 'roles.manage',
                    guard_name: 'web',
                    created_at: now,
                    updated_at: now,
                })
                .onConflict(['name', 'guard_name'])
                .ignore()
            await db.rawQuery(
                `INSERT INTO role_has_permissions (permission_id, role_id)
                 SELECT p.id, r.id FROM permissions p, roles r
                  WHERE p.name = 'roles.manage' AND p.guard_name = 'web'
                    AND r.name = 'super_admin' AND r.guard_name = 'web'
                 ON CONFLICT DO NOTHING`
            )
        })
    }

    async down() {
        this.schema.raw(`
            ALTER TABLE roles
                DROP COLUMN IF EXISTS label,
                DROP COLUMN IF EXISTS description,
                DROP COLUMN IF EXISTS site_scope,
                DROP COLUMN IF EXISTS is_system
        `)
    }
}
