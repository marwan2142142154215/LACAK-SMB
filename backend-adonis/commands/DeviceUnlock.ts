import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import { eloquentNow } from '#services/DeviceResource'

/**
 * Buka kunci device dari CMD (darurat) -- termasuk device yang sudah DIHAPUS
 * (soft delete), yang tidak bisa dibuka lagi lewat dashboard karena device
 * 404 di semua endpoint.
 *
 * Jalankan di server (folder backend-adonis, atau build-nya):
 *   node ace device:unlock <uuid-atau-id>
 *   node ace device:unlock 7 --by=1
 *
 * Yang dilakukan:
 *  1. Cari device termasuk yang terhapus.
 *  2. Pulihkan (deleted_at = NULL) bila terhapus, lalu set status 'online'.
 *  3. Catat perintah 'unlock' berstatus 'pending' -> realtime-gateway
 *     mengantarnya ke HP begitu HP terhubung lagi, lalu HP membuka kuncinya
 *     sendiri (DeviceLockStore.adminLocked jadi false).
 *
 * Catatan: HP harus bisa online lagi untuk menerima perintahnya. Kalau HP tak
 * pernah online lagi, satu-satunya jalan tersisa di HP adalah factory reset.
 */
export default class DeviceUnlock extends BaseCommand {
    static commandName = 'device:unlock'
    static description = 'Buka kunci device dari CMD (termasuk device yang sudah dihapus)'

    static options: CommandOptions = { startApp: true }

    @args.string({ description: 'UUID atau ID device yang mau dibuka kuncinya' })
    declare device: string

    @flags.number({
        description: 'ID user yang dicatat sebagai pengeluar perintah (default: user pertama / super admin)',
    })
    declare by: number | undefined

    async run() {
        const key = this.device.trim()
        const asId = Number(key)
        const isNumericId = Number.isInteger(asId) && String(asId) === key

        const device = await db
            .from('devices')
            .where((query) => {
                if (isNumericId) query.where('id', asId)
                else query.where('device_uuid', key)
            })
            .first()

        if (!device) {
            this.logger.error(`Device tidak ditemukan (UUID/ID: ${key}).`)
            this.exitCode = 1
            return
        }

        // issued_by wajib diisi: pakai yang diberikan, atau user pertama (biasanya super admin 'root').
        let issuedBy = this.by
        if (!issuedBy) {
            const user = await db.from('users').select('id').orderBy('id', 'asc').first()
            issuedBy = user?.id
        }
        if (!issuedBy) {
            this.logger.error('Tidak ada user untuk dicatat sebagai issued_by. Tambahkan --by=<userId>.')
            this.exitCode = 1
            return
        }

        const now = eloquentNow()
        await db.transaction(async (trx) => {
            await trx
                .from('devices')
                .where('id', device.id)
                .update({ deleted_at: null, status: 'online', updated_at: now })
            await trx.table('device_commands').insert({
                device_id: device.id,
                command_type: 'unlock',
                issued_by: issuedBy,
                issued_via: 'web_dashboard',
                status: 'pending',
                reason_note: 'Buka kunci darurat lewat CLI (device:unlock)',
                created_at: now,
                updated_at: now,
            })
        })

        const wasDeleted = device.deleted_at != null
        this.logger.success(
            `OK: device "${device.device_name ?? device.device_uuid}" (id ${device.id})` +
                `${wasDeleted ? ' dipulihkan dari terhapus,' : ''} status -> online, perintah buka-kunci dicatat.`
        )
        this.logger.info('HP akan membuka kuncinya sendiri begitu terhubung lagi ke server.')
    }
}
