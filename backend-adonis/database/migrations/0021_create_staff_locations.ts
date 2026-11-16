import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Lokasi staf dari agen native (APK di HP / aplikasi desktop di PC) selama staf
 * login & bekerja. Mirip `device_locations`, tetapi menempel ke USER, bukan device
 * -- hanya diisi user pemegang izin `location.share`. Lokasi diambil dari GPS/WiFi
 * perangkat (bukan IP) sehingga tahan-VPN; `source='ip'` atau akurasi buruk ditandai
 * `confidence='low'`, dan `is_mock=true` bila lokasi palsu (mock location Android)
 * terdeteksi. Hanya riwayat (append-only), tanpa updated_at.
 */
export default class extends BaseSchema {
    protected tableName = 'staff_locations'

    async up() {
        this.schema.createTable(this.tableName, (table) => {
            table.bigIncrements('id')
            table.bigInteger('user_id').notNullable().references('users.id').onDelete('CASCADE')
            // Site staf saat lokasi dilaporkan -- dasar siapa (manajer/leader) yang boleh melihat.
            table.bigInteger('organization_id').nullable()
            table.decimal('latitude', 10, 7).nullable()
            table.decimal('longitude', 10, 7).nullable()
            table.decimal('accuracy_meters', 8, 2).nullable()
            // gps | wifi | network | ip
            table.string('source', 20).notNullable()
            // high | low (sumber ip atau akurasi buruk = low)
            table.string('confidence', 10).notNullable().defaultTo('high')
            table.boolean('is_mock').notNullable().defaultTo(false)
            // android | desktop | web
            table.string('client', 20).notNullable()
            table.timestamp('captured_at', { useTz: false }).notNullable()
            table.timestamp('created_at', { useTz: false }).notNullable()
            table.index(['user_id', 'captured_at'])
        })
        this.schema.raw(
            "ALTER TABLE staff_locations ADD CONSTRAINT staff_locations_source_check CHECK (source IN ('gps','wifi','network','ip'))"
        )
        this.schema.raw(
            "ALTER TABLE staff_locations ADD CONSTRAINT staff_locations_confidence_check CHECK (confidence IN ('high','low'))"
        )
        this.schema.raw(
            "ALTER TABLE staff_locations ADD CONSTRAINT staff_locations_client_check CHECK (client IN ('android','desktop','web'))"
        )
    }

    async down() {
        this.schema.dropTable(this.tableName)
    }
}
