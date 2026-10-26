import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Briefing dengan peserta pilihan: daftar user yang diundang langsung oleh
 * pemimpin. Kosong = undangan menurut peran & site seperti sebelumnya.
 */
export default class extends BaseSchema {
    protected tableName = 'briefings'

    async up() {
        this.schema.alterTable(this.tableName, (table) => {
            table.json('invited_user_ids').notNullable().defaultTo('[]')
        })
    }

    async down() {
        this.schema.alterTable(this.tableName, (table) => {
            table.dropColumn('invited_user_ids')
        })
    }
}
