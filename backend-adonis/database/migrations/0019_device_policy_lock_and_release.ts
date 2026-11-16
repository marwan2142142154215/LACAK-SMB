import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Kebijakan penguncian HP aset perusahaan (Device Owner) + alur pelepasan perangkat.
 *
 * Dilaporkan APK Pelacak lewat event `device:info` (lihat DeviceTelemetry di gateway), hanya status
 * yang memang diungkapkan ke pemegang HP di layar APK:
 *  - location_policy_locked: lokasi/GPS dikunci menyala (Device Owner, DISALLOW_CONFIG_LOCATION) --
 *    selama APK aktif lokasi tidak bisa dimatikan pemegang HP.
 *  - uninstall_locked: aplikasi dikunci agar tidak bisa dihapus tanpa kode lepas dari admin
 *    (Device Owner, setUninstallBlocked).
 *  - location_service_on: status GPS HP saat ini (untuk HP non-Device-Owner yang lokasinya masih
 *    bisa dimatikan -- dashboard menampilkan peringatan dan HP meminta staf menyalakannya lagi).
 *
 * released_at: waktu perangkat DILEPAS lewat kode lepas (DeviceOtp purpose 'release'); saat itu juga
 * is_active disetel false. Device yang sudah dilepas tidak lagi diterima gateway.
 *
 * device_otps.purpose: CHECK lama hanya mengizinkan 'self_unlock'. Diperlonggar agar 'release' (kode
 * lepas perangkat) ikut sah.
 *
 * Aman dijalankan berulang (IF NOT EXISTS).
 */
export default class extends BaseSchema {
    async up() {
        this.schema.raw(`
            ALTER TABLE devices
                ADD COLUMN IF NOT EXISTS location_policy_locked boolean,
                ADD COLUMN IF NOT EXISTS uninstall_locked boolean,
                ADD COLUMN IF NOT EXISTS location_service_on boolean,
                ADD COLUMN IF NOT EXISTS released_at timestamp(0) without time zone
        `)
        this.schema.raw(
            'ALTER TABLE device_otps DROP CONSTRAINT IF EXISTS device_otps_purpose_check'
        )
        this.schema.raw(
            `ALTER TABLE device_otps ADD CONSTRAINT device_otps_purpose_check
                CHECK (((purpose)::text = ANY ((ARRAY['self_unlock'::character varying, 'release'::character varying])::text[])))`
        )
    }

    async down() {
        // Kode lepas bersifat sementara: buang sebelum memasang lagi CHECK lama (hanya 'self_unlock').
        this.schema.raw("DELETE FROM device_otps WHERE purpose = 'release'")
        this.schema.raw(
            'ALTER TABLE device_otps DROP CONSTRAINT IF EXISTS device_otps_purpose_check'
        )
        this.schema.raw(
            `ALTER TABLE device_otps ADD CONSTRAINT device_otps_purpose_check
                CHECK (((purpose)::text = 'self_unlock'::text))`
        )
        this.schema.raw(`
            ALTER TABLE devices
                DROP COLUMN IF EXISTS location_policy_locked,
                DROP COLUMN IF EXISTS uninstall_locked,
                DROP COLUMN IF EXISTS location_service_on,
                DROP COLUMN IF EXISTS released_at
        `)
    }
}
