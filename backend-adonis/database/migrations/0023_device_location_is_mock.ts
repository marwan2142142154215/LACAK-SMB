import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Penanda lokasi palsu (mock location) per fix device. APK Pelacak melaporkan
 * `isMock` dari Android (`Location.isMock` di API 31+, `isFromMockProvider` di
 * versi lama). Dipakai dashboard menandai device yang memakai GPS palsu -- padanan
 * "tahan-VPN" untuk HP. Default false supaya baris lama tetap valid.
 */
export default class extends BaseSchema {
    protected tableName = 'device_locations'

    async up() {
        this.schema.alterTable(this.tableName, (table) => {
            table.boolean('is_mock').notNullable().defaultTo(false)
        })
    }

    async down() {
        this.schema.alterTable(this.tableName, (table) => {
            table.dropColumn('is_mock')
        })
    }
}
