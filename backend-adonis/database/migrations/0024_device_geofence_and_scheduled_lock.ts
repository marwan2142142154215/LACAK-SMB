import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Dua fitur keamanan lokasi:
 *  1. Geofence per-HP: tiap device bisa dipatok ke koordinat + radius sendiri
 *     (selain aturan geofence per-site). Keluar radius -> auto-lock (lihat
 *     GeofenceEvaluator di realtime-gateway).
 *  2. Kunci terjadwal di luar jam kerja: saklar per-site (organizations) +
 *     penanda di device bahwa kuncinya dipasang oleh jadwal (supaya dibuka lagi
 *     saat jam kerja mulai, bukan dibiarkan terkunci).
 *
 * Kolom nullable / berdefault supaya baris lama tetap valid.
 */
export default class extends BaseSchema {
    async up() {
        this.schema.alterTable('devices', (table) => {
            // Pagar milik HP sendiri (numeric(10,7) menyamai latitude/longitude yang sudah ada).
            table.decimal('geofence_latitude', 10, 7).nullable()
            table.decimal('geofence_longitude', 10, 7).nullable()
            table.integer('geofence_radius_meters').nullable()
            // true = HP sedang dikunci oleh jadwal "di luar jam kerja" (bukan admin/geofence).
            table.boolean('scheduled_locked').notNullable().defaultTo(false)
        })
        this.schema.alterTable('organizations', (table) => {
            // Saklar: kunci otomatis semua HP site ini di luar jam kerja (work_shifts).
            table.boolean('after_hours_lock').notNullable().defaultTo(false)
        })
    }

    async down() {
        this.schema.alterTable('devices', (table) => {
            table.dropColumn('geofence_latitude')
            table.dropColumn('geofence_longitude')
            table.dropColumn('geofence_radius_meters')
            table.dropColumn('scheduled_locked')
        })
        this.schema.alterTable('organizations', (table) => {
            table.dropColumn('after_hours_lock')
        })
    }
}
