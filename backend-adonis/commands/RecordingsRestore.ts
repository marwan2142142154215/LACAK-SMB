import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import { DATE_PATTERN } from '#services/LocalTime'
import { recordingEnabled } from '#services/Recording'
import { planRestore } from '#services/RecordingRestore'
import { listSpaces } from '#services/Storage'

const INSERT_CHUNK = 500

/**
 * Membuat ulang baris rekaman untuk satu tanggal dari berkas yang masih ada di Spaces, supaya muncul lagi di
 * halaman Rekaman. Tanpa --apply hanya simulasi (tidak menulis apa pun).
 *
 * Catatan: pembersih otomatis tetap berlaku, jadi baris yang dipulihkan ikut dihapus lagi (berikut berkasnya)
 * begitu umurnya melewati masa simpan.
 */
export default class RecordingsRestore extends BaseCommand {
    static commandName = 'recordings:restore'
    static description =
        'Memulihkan baris rekaman satu tanggal dari berkas yang masih ada di Spaces'

    static options: CommandOptions = {
        startApp: true,
    }

    @flags.string({ description: 'Tanggal folder rekaman, yyyy-MM-dd (waktu kantor)' })
    declare date: string

    @flags.boolean({ description: 'Tulis ke database (tanpa ini hanya simulasi)' })
    declare apply: boolean

    async run() {
        if (!this.date || !DATE_PATTERN.test(this.date)) {
            this.logger.error('Isi --date=yyyy-MM-dd, mis. --date=2026-11-11')
            this.exitCode = 1
            return
        }
        if (!recordingEnabled()) {
            this.logger.error('Rekaman tidak aktif (Spaces/LiveKit belum diisi di .env)')
            this.exitCode = 1
            return
        }

        const folder = `recordings/${this.date}`
        const objects = await listSpaces(folder)
        const users = await db.from('users').select('id', 'name', 'organization_id')
        const existing = await db
            .from('live_recordings')
            .where('file_path', 'like', `${folder}/%`)
            .select('file_path')
        const plan = planRestore(
            objects,
            users,
            new Set(existing.map((row) => String(row.file_path)))
        )

        const { skipped } = plan
        this.logger.info(`Berkas di Spaces       : ${objects.length}`)
        this.logger.info(`Sudah punya baris      : ${skipped.existing}`)
        this.logger.info(`Bukan berkas rekaman   : ${skipped.unrecognized}`)
        this.logger.info(`Staf tidak ditemukan   : ${skipped.unknownStaff}`)
        this.logger.info(
            `Nama staf kembar       : ${skipped.ambiguousStaff} (dilewati, tidak ditebak)`
        )
        this.logger.info(`Akan dipulihkan        : ${plan.rows.length}`)

        if (!this.apply) {
            this.logger.info('Simulasi saja. Tambahkan --apply untuk menulis ke database.')
            return
        }

        const now = new Date()
        for (let index = 0; index < plan.rows.length; index += INSERT_CHUNK) {
            const chunk = plan.rows.slice(index, index + INSERT_CHUNK).map((row) => ({
                ...row,
                work_session_id: null,
                status: 'completed',
                created_at: now,
                updated_at: now,
            }))
            await db.table('live_recordings').multiInsert(chunk)
        }
        this.logger.success(`${plan.rows.length} baris rekaman dipulihkan.`)
    }
}
