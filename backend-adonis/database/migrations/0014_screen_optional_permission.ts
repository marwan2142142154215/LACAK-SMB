import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Izin live.screen-optional ("Boleh menutup layar"): peran yang memegangnya tidak wajib
 * membagikan layar saat Live Kerja. Sesinya ditandai work_sessions.screen_optional (diisi
 * server saat Mulai kerja, bukan oleh client) supaya status tidak jatuh ke Screen off.
 *
 * Izin hanya dibuat; siapa yang memegangnya diatur dari menu Peran. Aman dijalankan berulang.
 */
const PERMISSION = 'live.screen-optional'

export default class extends BaseSchema {
    async up() {
        this.schema.raw(
            'ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS screen_optional boolean NOT NULL DEFAULT false'
        )

        this.defer(async (db) => {
            const now = new Date()
            await db
                .table('permissions')
                .insert({ name: PERMISSION, guard_name: 'web', created_at: now, updated_at: now })
                .onConflict(['name', 'guard_name'])
                .ignore()
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
        this.schema.raw('ALTER TABLE work_sessions DROP COLUMN IF EXISTS screen_optional')
    }
}
