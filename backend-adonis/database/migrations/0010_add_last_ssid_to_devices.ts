import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Nama WiFi (SSID) yang sedang terhubung di device, diperbarui tiap heartbeat
 * oleh gateway. APK Pelacak sudah mengirim SSID ini untuk evaluasi geofence
 * (lihat realtime-gateway geofence_evaluator.ts); kolom ini hanya menyimpan
 * yang terakhir supaya bisa ditampilkan di status device. BUKAN password WiFi
 * atau data pribadi -- hanya nama jaringannya, sejalan dengan allowed_ssid.
 */
export default class extends BaseSchema {
    protected tableName = 'devices'

    async up() {
        this.schema.alterTable(this.tableName, (table) => {
            table.string('last_ssid', 255).nullable()
        })
    }

    async down() {
        this.schema.alterTable(this.tableName, (table) => {
            table.dropColumn('last_ssid')
        })
    }
}
