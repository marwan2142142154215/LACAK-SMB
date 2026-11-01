import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { deleteLiveRoom, isLegacyLiveRoom, listLiveRooms } from '#services/Livekit'

/**
 * Daftar room Live Kerja di LiveKit. Siaran yang dimulai SEBELUM "ruang per peran" masih ada di room lama
 * (site-{id} / leaders): dashboard dan rekorder hanya melihat room baru (site-{id}-{peran}), jadi staf itu
 * tidak terlihat dan tidak terekam sampai sambungannya diperbarui.
 *
 * Tanpa opsi: hanya menampilkan. --close-legacy menutup room lama; siaran staf di dalamnya terputus lalu
 * menyambung ulang sendiri dengan token baru (5-25 detik), tapi LAYAR harus dibagikan ulang oleh staf.
 */
export default class LiveRooms extends BaseCommand {
    static commandName = 'live:rooms'
    static description =
        'Menampilkan room LiveKit Live Kerja dan (opsional) menutup room format lama'

    static options: CommandOptions = {
        startApp: true,
    }

    @flags.boolean({
        description: 'Tutup room format lama (peserta menyambung ulang ke room baru)',
    })
    declare closeLegacy: boolean

    async run() {
        const listed = await listLiveRooms()
        const rooms = listed.sort((a, b) => a.name.localeCompare(b.name))
        const legacy = rooms.filter((room) => isLegacyLiveRoom(room.name))
        const current = rooms.filter((room) => !isLegacyLiveRoom(room.name))

        const total = (list: typeof rooms) => list.reduce((sum, room) => sum + room.participants, 0)
        this.logger.info(`Room baru   : ${current.length} room, ${total(current)} peserta`)
        this.logger.info(
            `Room lama   : ${legacy.length} room, ${total(legacy)} peserta (tidak terlihat di dashboard & tidak direkam)`
        )
        for (const room of legacy)
            this.logger.info(`  - ${room.name}: ${room.participants} peserta`)

        if (!this.closeLegacy) {
            if (legacy.length) this.logger.info('Tambahkan --close-legacy untuk menutup room lama.')
            return
        }

        let closed = 0
        for (const room of legacy) {
            try {
                await deleteLiveRoom(room.name)
                closed++
            } catch (error) {
                this.logger.error(
                    `Gagal menutup ${room.name}: ${error instanceof Error ? error.message : error}`
                )
            }
        }
        this.logger.success(`${closed} room lama ditutup.`)
    }
}
