import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Kunci HP mengikuti jadwal shift PEMEGANGNYA (berbeda dari kunci per-site
 * "di luar jam kerja" di migrasi 0024):
 *  1. devices.holder_user_id: staf yang memegang HP ini. Kunci per-shift-staf
 *     memakai shift milik pemegang ini (staff_shifts -> work_shifts). SET NULL
 *     kalau user dihapus, supaya HP kembali "tanpa pemegang" (dibiarkan).
 *  2. organizations.staff_shift_lock: saklar per-site. Saat aktif, HP di site
 *     yang SUDAH ada pemegangnya dikunci saat pemegangnya di luar shift (atau
 *     sedang cuti), dibuka lagi saat shift-nya mulai. HP tanpa pemegang & staf
 *     tanpa shift dibiarkan (lihat StaffShiftDeviceLock).
 *
 * Kolom nullable / berdefault supaya baris lama tetap valid.
 */
export default class extends BaseSchema {
    async up() {
        this.schema.alterTable('devices', (table) => {
            table
                .bigInteger('holder_user_id')
                .nullable()
                .references('users.id')
                .onDelete('SET NULL')
        })
        this.schema.alterTable('organizations', (table) => {
            table.boolean('staff_shift_lock').notNullable().defaultTo(false)
        })
    }

    async down() {
        this.schema.alterTable('devices', (table) => {
            table.dropColumn('holder_user_id')
        })
        this.schema.alterTable('organizations', (table) => {
            table.dropColumn('staff_shift_lock')
        })
    }
}
