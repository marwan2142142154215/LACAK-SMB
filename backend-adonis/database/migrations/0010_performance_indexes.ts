import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Indeks untuk query yang paling sering dan paling berat (hasil audit performa):
 * - work_session_events (work_session_id, type, id DESC): cek peringatan kerja tiap menit.
 * - activity_log (created_at): filter rentang tanggal di Log aktivitas.
 * - users lower(email): pencocokan email massal (dialog Update staf).
 * - pg_trgm (kalau bisa dipasang): pencarian "mengandung" di staf, device, dan site.
 * Semua IF NOT EXISTS, aman diulang. Kegagalan memasang pg_trgm tidak menggagalkan migrasi
 * (pencarian tetap jalan, hanya tanpa indeks trigram).
 */
const PLAIN_INDEXES = [
    `CREATE INDEX IF NOT EXISTS work_session_events_session_type_id_idx
        ON work_session_events (work_session_id, type, id DESC)`,
    `CREATE INDEX IF NOT EXISTS activity_log_created_at_idx ON activity_log (created_at)`,
    `CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email))`,
]

const TRIGRAM_INDEXES: [string, string, string][] = [
    ['users_name_trgm_idx', 'users', 'name'],
    ['users_username_trgm_idx', 'users', 'username'],
    ['users_email_trgm_idx', 'users', 'email'],
    ['devices_device_name_trgm_idx', 'devices', 'device_name'],
    ['devices_device_uuid_trgm_idx', 'devices', 'device_uuid'],
    ['organizations_name_trgm_idx', 'organizations', 'name'],
    ['organizations_site_code_trgm_idx', 'organizations', 'unique_site_code'],
]

export default class extends BaseSchema {
    async up() {
        this.defer(async (db) => {
            for (const statement of PLAIN_INDEXES) await db.rawQuery(statement)

            // SAVEPOINT: pemasangan ekstensi yang gagal (hak akses) tidak boleh membatalkan seluruh migrasi.
            await db.rawQuery('SAVEPOINT trigram')
            try {
                await db.rawQuery('CREATE EXTENSION IF NOT EXISTS pg_trgm')
                for (const [name, table, column] of TRIGRAM_INDEXES) {
                    await db.rawQuery(
                        `CREATE INDEX IF NOT EXISTS ${name} ON ${table} USING gin (${column} gin_trgm_ops)`
                    )
                }
                await db.rawQuery('RELEASE SAVEPOINT trigram')
            } catch (error) {
                await db.rawQuery('ROLLBACK TO SAVEPOINT trigram')
                console.warn(
                    `[0010] Indeks trigram dilewati (${(error as Error).message}). ` +
                        'Pasang pg_trgm sebagai superuser (CREATE EXTENSION pg_trgm) lalu jalankan ulang migrasi ini.'
                )
            }
        })
    }

    async down() {
        this.schema.raw(`
            DROP INDEX IF EXISTS work_session_events_session_type_id_idx;
            DROP INDEX IF EXISTS activity_log_created_at_idx;
            DROP INDEX IF EXISTS users_email_lower_idx;
        `)
        for (const [name] of TRIGRAM_INDEXES) this.schema.raw(`DROP INDEX IF EXISTS ${name}`)
    }
}
