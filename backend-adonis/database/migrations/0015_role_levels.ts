import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Tingkatan peran (roles.level, 0 = root ... 100 = paling bawah): user hanya melihat user yang
 * levelnya lebih besar dari levelnya sendiri. Peran baru otomatis level 100 (hanya melihat dirinya
 * sendiri) sampai diatur di menu Peran. Level awal peran bawaan di bawah ini; peran buatan sendiri
 * yang selama ini memegang izin live.roster (pengawas) dipasang 50 supaya tetap bisa mengawasi staf.
 */
const BUILT_IN_LEVELS = [
    ['super_admin', 0],
    ['admin', 10],
    ['site_admin', 30],
    ['leader', 50],
    ['staff_viewer', 100],
    ['telegram_bot_service', 100],
] as const

const SUPERVISOR_LEVEL = 50

export default class extends BaseSchema {
    protected tableName = 'roles'

    async up() {
        this.schema.raw(`
            ALTER TABLE roles
                ADD COLUMN IF NOT EXISTS level smallint NOT NULL DEFAULT 100
                    CHECK (level BETWEEN 0 AND 100)
        `)

        this.defer(async (db) => {
            for (const [name, level] of BUILT_IN_LEVELS) {
                await db.rawQuery(
                    `UPDATE roles SET level = ? WHERE name = ? AND guard_name = 'web'`,
                    [level, name]
                )
            }

            await db.rawQuery(
                `UPDATE roles SET level = ?
                  WHERE guard_name = 'web'
                    AND name NOT IN (${BUILT_IN_LEVELS.map(() => '?').join(', ')})
                    AND id IN (
                        SELECT rp.role_id
                          FROM role_has_permissions rp
                          JOIN permissions p ON p.id = rp.permission_id
                         WHERE p.name = 'live.roster' AND p.guard_name = 'web'
                    )`,
                [SUPERVISOR_LEVEL, ...BUILT_IN_LEVELS.map(([name]) => name)]
            )
        })
    }

    async down() {
        this.schema.raw('ALTER TABLE roles DROP COLUMN IF EXISTS level')
    }
}
