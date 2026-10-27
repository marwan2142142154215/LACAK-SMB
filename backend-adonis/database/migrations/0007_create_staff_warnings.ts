import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Peringatan dari leader ke atas untuk satu staf. Muncul sebagai popup di
 * dashboard staf itu sampai ia menekan "Saya mengerti" (acknowledged_at);
 * semuanya disimpan sebagai riwayat peringatan per staf.
 */
export default class extends BaseSchema {
    protected tableName = 'staff_warnings'

    async up() {
        this.schema.createTable(this.tableName, (table) => {
            table.bigIncrements('id')
            table.bigInteger('user_id').notNullable().references('users.id').onDelete('CASCADE')
            table.bigInteger('issued_by').nullable().references('users.id').onDelete('SET NULL')
            // Site staf saat peringatan diberikan -- dasar siapa yang boleh melihat riwayatnya.
            table.bigInteger('organization_id').nullable()
            // teguran | keras
            table.string('level', 20).notNullable()
            table.text('message').notNullable()
            table.timestamp('acknowledged_at', { useTz: false }).nullable()
            table.timestamp('created_at', { useTz: false }).notNullable()
            table.timestamp('updated_at', { useTz: false }).notNullable()
            table.index(['user_id', 'acknowledged_at'])
        })
    }

    async down() {
        this.schema.dropTable(this.tableName)
    }
}
