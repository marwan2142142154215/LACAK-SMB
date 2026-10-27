import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Pengelolaan kerja: shift & absensi, izin/cuti, jadwal & daftar hadir
 * briefing, pengumuman, catatan kerja, serta peringatan & laporan Telegram.
 * Jam (start_time, end_time, report_time) berupa "HH:mm" waktu lokal
 * APP_TIMEZONE; kolom timestamp tetap UTC seperti tabel lain.
 */
export default class extends BaseSchema {
    async up() {
        this.schema.createTable('work_shifts', (table) => {
            table.bigIncrements('id')
            table
                .bigInteger('organization_id')
                .notNullable()
                .references('organizations.id')
                .onDelete('CASCADE')
            table.string('name', 80).notNullable()
            table.string('start_time', 5).notNullable()
            table.string('end_time', 5).notNullable()
            // Hari kerja ISO: 1 = Senin ... 7 = Minggu.
            table.json('days').notNullable().defaultTo('[1,2,3,4,5]')
            table.integer('late_tolerance_minutes').notNullable().defaultTo(10)
            table.bigInteger('created_by').nullable()
            table.timestamp('created_at', { useTz: false }).nullable()
            table.timestamp('updated_at', { useTz: false }).nullable()
            table.index(['organization_id'])
        })

        this.schema.createTable('staff_shifts', (table) => {
            table.bigInteger('user_id').primary().references('users.id').onDelete('CASCADE')
            table
                .bigInteger('work_shift_id')
                .notNullable()
                .references('work_shifts.id')
                .onDelete('CASCADE')
            table.timestamp('created_at', { useTz: false }).nullable()
            table.timestamp('updated_at', { useTz: false }).nullable()
        })

        this.schema.createTable('leave_requests', (table) => {
            table.bigIncrements('id')
            table.bigInteger('user_id').notNullable().references('users.id').onDelete('CASCADE')
            table.bigInteger('organization_id').nullable()
            // izin | sakit | cuti
            table.string('type', 16).notNullable()
            table.date('start_date').notNullable()
            table.date('end_date').notNullable()
            table.text('reason').notNullable()
            // pending | approved | rejected | cancelled
            table.string('status', 16).notNullable().defaultTo('pending')
            table.bigInteger('reviewed_by').nullable()
            table.timestamp('reviewed_at', { useTz: false }).nullable()
            table.string('review_note', 500).nullable()
            table.timestamp('created_at', { useTz: false }).nullable()
            table.timestamp('updated_at', { useTz: false }).nullable()
            table.index(['user_id', 'start_date'])
            table.index(['organization_id', 'status'])
        })

        this.schema.createTable('briefing_schedules', (table) => {
            table.bigIncrements('id')
            table.string('title', 120).notNullable()
            table.bigInteger('host_user_id').notNullable()
            table.json('allowed_roles').notNullable().defaultTo('[]')
            table.json('allowed_organization_ids').notNullable().defaultTo('[]')
            table.json('invited_user_ids').notNullable().defaultTo('[]')
            // once | daily | weekdays | weekly
            table.string('recurrence', 16).notNullable().defaultTo('once')
            table.date('start_date').notNullable()
            table.string('start_time', 5).notNullable()
            table.integer('duration_minutes').notNullable().defaultTo(30)
            // Jadwal berikutnya (UTC); null = tidak ada lagi.
            table.timestamp('next_run_at', { useTz: false }).nullable()
            table.timestamp('reminded_at', { useTz: false }).nullable()
            table.boolean('is_active').notNullable().defaultTo(true)
            table.timestamp('created_at', { useTz: false }).nullable()
            table.timestamp('updated_at', { useTz: false }).nullable()
            table.index(['is_active', 'next_run_at'])
        })

        this.schema.alterTable('briefings', (table) => {
            table.bigInteger('schedule_id').nullable()
            // Briefing terjadwal ditutup otomatis sesudah durasinya bila ruangnya kosong.
            table.timestamp('planned_end_at', { useTz: false }).nullable()
        })

        this.schema.createTable('briefing_attendances', (table) => {
            table.bigIncrements('id')
            table
                .bigInteger('briefing_id')
                .notNullable()
                .references('briefings.id')
                .onDelete('CASCADE')
            table.bigInteger('user_id').notNullable()
            table.timestamp('joined_at', { useTz: false }).notNullable()
            // Detak terakhir dari dashboard peserta (tiap ~30 detik selama di ruang).
            table.timestamp('last_seen_at', { useTz: false }).notNullable()
            table.index(['briefing_id', 'user_id'])
        })

        this.schema.createTable('announcements', (table) => {
            table.bigIncrements('id')
            table.string('title', 120).notNullable()
            table.text('body').notNullable()
            table.bigInteger('author_id').notNullable()
            table.json('allowed_roles').notNullable().defaultTo('[]')
            // Kosong = semua site milik penulis (root: semua site).
            table.json('allowed_organization_ids').notNullable().defaultTo('[]')
            table.boolean('is_important').notNullable().defaultTo(false)
            table.timestamp('expires_at', { useTz: false }).nullable()
            table.timestamp('created_at', { useTz: false }).nullable()
            table.timestamp('updated_at', { useTz: false }).nullable()
        })

        this.schema.createTable('announcement_reads', (table) => {
            table
                .bigInteger('announcement_id')
                .notNullable()
                .references('announcements.id')
                .onDelete('CASCADE')
            table.bigInteger('user_id').notNullable()
            table.timestamp('read_at', { useTz: false }).notNullable()
            table.primary(['announcement_id', 'user_id'])
        })

        this.schema.alterTable('work_sessions', (table) => {
            // Catatan kerja yang ditulis staf saat Selesai kerja.
            table.text('end_note').nullable()
        })

        this.schema.createTable('work_alert_settings', (table) => {
            table
                .bigInteger('organization_id')
                .primary()
                .references('organizations.id')
                .onDelete('CASCADE')
            table.boolean('alerts_enabled').notNullable().defaultTo(true)
            table.integer('camera_off_minutes').notNullable().defaultTo(10)
            table.integer('face_missing_minutes').notNullable().defaultTo(10)
            table.boolean('absent_alert').notNullable().defaultTo(true)
            table.boolean('daily_report').notNullable().defaultTo(true)
            table.boolean('weekly_report').notNullable().defaultTo(true)
            table.string('report_time', 5).notNullable().defaultTo('17:00')
            table.bigInteger('updated_by').nullable()
            table.timestamp('created_at', { useTz: false }).nullable()
            table.timestamp('updated_at', { useTz: false }).nullable()
        })

        this.schema.createTable('work_alerts', (table) => {
            table.bigIncrements('id')
            table.bigInteger('organization_id').nullable()
            table.bigInteger('user_id').nullable()
            // camera_off | screen_off | face_missing | absent | daily_report | weekly_report | briefing_reminder
            table.string('type', 32).notNullable()
            // Mencegah pesan yang sama terkirim dua kali.
            table.string('dedupe_key', 191).notNullable().unique()
            table.text('message').notNullable()
            table.boolean('sent_telegram').notNullable().defaultTo(false)
            table.timestamp('created_at', { useTz: false }).notNullable()
            table.index(['organization_id', 'created_at'])
        })
    }

    async down() {
        this.schema.dropTable('work_alerts')
        this.schema.dropTable('work_alert_settings')
        this.schema.alterTable('work_sessions', (table) => table.dropColumn('end_note'))
        this.schema.dropTable('announcement_reads')
        this.schema.dropTable('announcements')
        this.schema.dropTable('briefing_attendances')
        this.schema.alterTable('briefings', (table) => {
            table.dropColumn('schedule_id')
            table.dropColumn('planned_end_at')
        })
        this.schema.dropTable('briefing_schedules')
        this.schema.dropTable('leave_requests')
        this.schema.dropTable('staff_shifts')
        this.schema.dropTable('work_shifts')
    }
}
