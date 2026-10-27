import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fitur dokumen consent dihapus: device & APK tracker baru tidak lagi
 * membutuhkan dokumen consent. Tabel consent_documents dan isinya sengaja
 * DIBIARKAN (riwayat lama & log aktivitas tetap utuh); hanya kolom
 * devices.consent_document_id yang kini boleh kosong.
 */
export default class extends BaseSchema {
    protected tableName = 'devices'

    async up() {
        this.schema.alterTable(this.tableName, (table) => {
            table.bigInteger('consent_document_id').nullable().alter()
        })
    }

    async down() {
        // Hanya bisa dikembalikan kalau tidak ada device tanpa consent.
        this.schema.alterTable(this.tableName, (table) => {
            table.bigInteger('consent_document_id').notNullable().alter()
        })
    }
}
