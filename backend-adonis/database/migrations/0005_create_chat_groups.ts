import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Grup chat buatan user: nama bebas, anggota dipilih pembuatnya dari rekan
 * di site yang sama. Pesannya memakai tabel chat_messages yang sama dengan
 * chat site (gambar, balasan), dengan chat_group_id terisi dan
 * organization_id kosong.
 */
export default class extends BaseSchema {
    async up() {
        this.schema.createTable('chat_groups', (table) => {
            table.bigIncrements('id')
            table.string('name', 80).notNullable()
            table.bigInteger('created_by').nullable()
            table.timestamp('created_at', { useTz: false }).nullable()
            table.timestamp('updated_at', { useTz: false }).nullable()
        })

        this.schema.createTable('chat_group_members', (table) => {
            table
                .bigInteger('chat_group_id')
                .notNullable()
                .references('chat_groups.id')
                .onDelete('CASCADE')
            table.bigInteger('user_id').notNullable().references('users.id').onDelete('CASCADE')
            // Pengelola grup: ganti nama, tambah & keluarkan anggota, hapus grup.
            table.boolean('is_admin').notNullable().defaultTo(false)
            // Pesan terakhir yang sudah dibaca -- badge belum dibaca lintas perangkat.
            table.bigInteger('last_read_message_id').nullable()
            table.timestamp('joined_at', { useTz: false }).notNullable()
            table.primary(['chat_group_id', 'user_id'])
            table.index(['user_id'])
        })

        this.schema.alterTable('chat_messages', (table) => {
            table.bigInteger('organization_id').nullable().alter()
            table
                .bigInteger('chat_group_id')
                .nullable()
                .references('chat_groups.id')
                .onDelete('CASCADE')
            table.index(['chat_group_id', 'id'])
        })
    }

    async down() {
        this.schema.alterTable('chat_messages', (table) => {
            table.dropIndex(['chat_group_id', 'id'])
            table.dropForeign(['chat_group_id'])
            table.dropColumn('chat_group_id')
        })
        this.defer(async (db) => {
            await db.from('chat_messages').whereNull('organization_id').delete()
        })
        this.schema.alterTable('chat_messages', (table) => {
            table.bigInteger('organization_id').notNullable().alter()
        })
        this.schema.dropTable('chat_group_members')
        this.schema.dropTable('chat_groups')
    }
}
