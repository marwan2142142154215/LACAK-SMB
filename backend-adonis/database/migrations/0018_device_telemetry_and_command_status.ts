import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Detail perangkat, lokasi lengkap, dan status perintah yang bisa dilacak.
 *
 * devices: data perangkat yang DIUNGKAPKAN ke pemegang HP di layar APK Pelacak (merek, model, versi
 * app, status cas, jenis jaringan + operator, sisa penyimpanan, status izin app). Tidak ada kolom
 * untuk isi pesan, kontak, riwayat panggilan, foto, atau isi aplikasi lain -- memang tidak dikumpulkan.
 *
 * device_locations: akurasi (meter), sumber fix (gps/network/fused), dan waktu fix diambil di HP --
 * bisa lebih tua dari recorded_at kalau GPS belum dapat posisi baru.
 *
 * device_commands: jejak pengiriman (delivered_at, delivery_attempts), hasil dari HP (executed_at,
 * result_message), status baru 'executed' (dijalankan HP) dan 'expired' (kedaluwarsa / digantikan
 * perintah lebih baru). 'acknowledged' tetap berarti "diterima HP".
 *
 * Aman dijalankan berulang (IF NOT EXISTS).
 */
const COMMAND_STATUSES = ['pending', 'delivered', 'acknowledged', 'executed', 'failed', 'expired']
const OLD_COMMAND_STATUSES = ['pending', 'delivered', 'acknowledged', 'failed']

function statusCheck(statuses: string[]) {
    const list = statuses.map((status) => `'${status}'::character varying`).join(', ')
    return `CHECK (((status)::text = ANY ((ARRAY[${list}])::text[])))`
}

export default class extends BaseSchema {
    async up() {
        this.schema.raw(`
            ALTER TABLE devices
                ADD COLUMN IF NOT EXISTS manufacturer varchar(100),
                ADD COLUMN IF NOT EXISTS model varchar(100),
                ADD COLUMN IF NOT EXISTS app_version_code integer,
                ADD COLUMN IF NOT EXISTS is_charging boolean,
                ADD COLUMN IF NOT EXISTS network_type varchar(20),
                ADD COLUMN IF NOT EXISTS carrier_name varchar(100),
                ADD COLUMN IF NOT EXISTS storage_free_mb integer,
                ADD COLUMN IF NOT EXISTS storage_total_mb integer,
                ADD COLUMN IF NOT EXISTS permission_state jsonb,
                ADD COLUMN IF NOT EXISTS info_updated_at timestamp(0) without time zone
        `)
        this.schema.raw(`
            ALTER TABLE device_locations
                ADD COLUMN IF NOT EXISTS accuracy_meters numeric(8,2),
                ADD COLUMN IF NOT EXISTS location_provider varchar(20),
                ADD COLUMN IF NOT EXISTS fixed_at timestamp(0) without time zone
        `)
        this.schema.raw(`
            ALTER TABLE device_commands
                ADD COLUMN IF NOT EXISTS delivered_at timestamp(0) without time zone,
                ADD COLUMN IF NOT EXISTS executed_at timestamp(0) without time zone,
                ADD COLUMN IF NOT EXISTS result_message varchar(255),
                ADD COLUMN IF NOT EXISTS delivery_attempts smallint NOT NULL DEFAULT 0
        `)
        this.schema.raw(
            'ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_status_check'
        )
        this.schema.raw(
            `ALTER TABLE device_commands ADD CONSTRAINT device_commands_status_check ${statusCheck(COMMAND_STATUSES)}`
        )
        // Dispatcher gateway mencari perintah yang belum selesai per device tiap 2 detik.
        this.schema.raw(
            `CREATE INDEX IF NOT EXISTS device_commands_open_status_index
                ON device_commands (status, device_id)
                WHERE status IN ('pending', 'delivered')`
        )
    }

    async down() {
        this.schema.raw('DROP INDEX IF EXISTS device_commands_open_status_index')
        // Status baru dikembalikan ke padanan lama sebelum CHECK lama dipasang lagi.
        this.schema.raw(
            "UPDATE device_commands SET status = 'acknowledged' WHERE status = 'executed'"
        )
        this.schema.raw("UPDATE device_commands SET status = 'failed' WHERE status = 'expired'")
        this.schema.raw(
            'ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_status_check'
        )
        this.schema.raw(
            `ALTER TABLE device_commands ADD CONSTRAINT device_commands_status_check ${statusCheck(OLD_COMMAND_STATUSES)}`
        )
        this.schema.raw(`
            ALTER TABLE device_commands
                DROP COLUMN IF EXISTS delivered_at,
                DROP COLUMN IF EXISTS executed_at,
                DROP COLUMN IF EXISTS result_message,
                DROP COLUMN IF EXISTS delivery_attempts
        `)
        this.schema.raw(`
            ALTER TABLE device_locations
                DROP COLUMN IF EXISTS accuracy_meters,
                DROP COLUMN IF EXISTS location_provider,
                DROP COLUMN IF EXISTS fixed_at
        `)
        this.schema.raw(`
            ALTER TABLE devices
                DROP COLUMN IF EXISTS manufacturer,
                DROP COLUMN IF EXISTS model,
                DROP COLUMN IF EXISTS app_version_code,
                DROP COLUMN IF EXISTS is_charging,
                DROP COLUMN IF EXISTS network_type,
                DROP COLUMN IF EXISTS carrier_name,
                DROP COLUMN IF EXISTS storage_free_mb,
                DROP COLUMN IF EXISTS storage_total_mb,
                DROP COLUMN IF EXISTS permission_state,
                DROP COLUMN IF EXISTS info_updated_at
        `)
    }
}
