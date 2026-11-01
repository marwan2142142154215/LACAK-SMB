import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Live Kerja dari iPhone: Safari/PWA iPhone tidak bisa membagikan layar, jadi sesinya
 * "kamera saja" (work_sessions.camera_only). Layar tidak dihitung wajib untuk sesi ini
 * (status tidak jatuh ke Screen off), dan atasan melihat penandanya di Live Kerja.
 * Aman dijalankan berulang.
 */
export default class extends BaseSchema {
    async up() {
        this.schema.raw(
            'ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS camera_only boolean NOT NULL DEFAULT false'
        )
    }

    async down() {
        this.schema.raw('ALTER TABLE work_sessions DROP COLUMN IF EXISTS camera_only')
    }
}
