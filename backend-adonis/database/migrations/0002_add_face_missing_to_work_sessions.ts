import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Cek wajah Live Kerja: true = kamera menyala tapi tidak ada wajah >= 30 detik.
 * Hanya dicatat (kejadian face_lost / face_back) -- tidak mengubah status
 * kerja maupun jam kerja.
 */
export default class extends BaseSchema {
    protected tableName = 'work_sessions'

    async up() {
        this.schema.alterTable(this.tableName, (table) => {
            table.boolean('face_missing').notNullable().defaultTo(false)
        })
    }

    async down() {
        this.schema.alterTable(this.tableName, (table) => {
            table.dropColumn('face_missing')
        })
    }
}
