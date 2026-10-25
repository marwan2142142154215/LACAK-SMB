import { readFile } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'
import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * 44 migrasi Laravel (backend-api) yang skemanya dirangkum di
 * database/schema/baseline.sql. Database lama wajib sudah menjalankan
 * semuanya sebelum Adonis mengambil alih skema.
 */
const LARAVEL_MIGRATIONS = [
    '0001_01_01_000000_create_users_table',
    '0001_01_01_000001_create_cache_table',
    '0001_01_01_000002_create_jobs_table',
    '2026_10_07_193228_create_activity_log_table',
    '2026_10_07_193228_create_permission_tables',
    '2026_10_07_193228_create_personal_access_tokens_table',
    '2026_10_07_193229_add_event_column_to_activity_log_table',
    '2026_10_07_193230_add_batch_uuid_column_to_activity_log_table',
    '2026_10_07_193252_create_organizations_table',
    '2026_10_07_193253_add_organization_foreign_key_to_users_table',
    '2026_10_07_193254_create_consent_documents_table',
    '2026_10_07_193255_create_devices_table',
    '2026_10_07_193256_create_device_locations_table',
    '2026_10_07_193257_create_geofence_rules_table',
    '2026_10_07_193258_create_violation_logs_table',
    '2026_10_07_193259_create_device_commands_table',
    '2026_10_07_193300_create_device_otps_table',
    '2026_10_07_193301_create_apk_builds_table',
    '2026_10_07_193302_create_telegram_bindings_table',
    '2026_10_08_105819_add_apk_type_and_status_to_apk_builds_table',
    '2026_10_08_113009_convert_type_and_signer_role_to_varchar',
    '2026_10_08_113246_create_user_site_access_table',
    '2026_10_08_150751_add_gps_center_to_geofence_rules_table',
    '2026_10_08_154126_add_anchor_device_to_geofence_rules_table',
    '2026_10_09_175319_add_device_secret_to_devices_table',
    '2026_10_09_175348_add_pairing_purpose_to_device_otps_table',
    '2026_10_09_222144_create_telegram_user_links_table',
    '2026_10_10_114332_add_device_id_to_apk_builds_table',
    '2026_10_10_120000_add_missing_foreign_key_indexes',
    '2026_10_10_140000_add_secret_hash_to_devices_table',
    '2026_10_10_150000_add_updated_at_to_log_tables',
    '2026_10_10_150100_add_audit_user_columns_to_consent_geofence_telegram_tables',
    '2026_10_23_090000_create_work_sessions_table',
    '2026_10_23_120000_hash_existing_device_secrets',
    '2026_10_24_090000_create_app_settings_table',
    '2026_10_24_100000_lowercase_existing_usernames',
    '2026_10_24_110000_add_presence_to_work_sessions_table',
    '2026_10_24_120000_create_chat_messages_table',
    '2026_10_25_090000_add_image_and_reply_to_chat_messages_table',
    '2026_10_25_120000_add_context_to_activity_log_table',
    '2026_10_25_130000_add_device_type_to_personal_access_tokens_table',
    '2026_10_25_140000_create_live_recordings_table',
    '2026_10_25_150000_allow_leader_work_sessions',
    '2026_10_25_160000_create_briefings_table',
]

/**
 * Skema dasar: titik awal migrasi Lucid setelah backend-api (Laravel) dilepas.
 *
 * - Database kosong (instalasi baru, database tes): seluruh skema dibuat dari
 *   database/schema/baseline.sql.
 * - Database lama (produksi, server uji): skema sudah ada, cukup dicatat
 *   sudah jalan -- asal semua migrasi Laravel di atas memang sudah dijalankan.
 */
export default class extends BaseSchema {
    async up() {
        this.defer(async (db) => {
            if (!(await db.schema.hasTable('users'))) {
                const sql = await readFile(app.makePath('database/schema/baseline.sql'), 'utf8')
                await db.rawQuery(sql)
                return
            }

            if (!(await db.schema.hasTable('migrations'))) {
                throw new Error(
                    'Tabel users sudah ada tapi bukan dari migrasi Laravel/baseline -- periksa database ini.'
                )
            }
            const rows = await db.from('migrations').select('migration')
            const done = new Set(rows.map((row) => row.migration))
            const missing = LARAVEL_MIGRATIONS.filter((name) => !done.has(name))
            if (missing.length) {
                throw new Error(
                    `Migrasi Laravel belum dijalankan di database ini: ${missing.join(', ')}. ` +
                        'Jalankan "php artisan migrate --force" di backend-api versi terakhir dulu.'
                )
            }
        })
    }

    async down() {
        // Sengaja kosong: skema dasar tidak pernah dibongkar lewat rollback.
    }
}
