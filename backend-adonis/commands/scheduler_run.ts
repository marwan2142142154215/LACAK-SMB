import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import {
    closeQueue,
    dispatch,
    JOB_QUEUE_HEARTBEAT,
    recordHeartbeat,
    SCHEDULER_HEARTBEAT_KEY,
} from '#services/queue'
import { runBriefingSchedules } from '#services/briefing_schedule'
import { pruneRecordings, rotateRecordings } from '#services/recording'
import { runWorkAlerts } from '#services/work_alerts'
import { closeStaleWorkSessions } from './close_stale_work_sessions.js'

/** Milidetik sampai awal menit berikutnya (jadwal Laravel jalan tepat di detik 0). */
export function msUntilNextMinute(now: Date = new Date()): number {
    return 60_000 - (now.getTime() % 60_000)
}

/**
 * Pengganti `php artisan schedule:work` (routes/console.php backend-api),
 * proses yang terus hidup (unit systemd lacak-scheduler). Tiap menit:
 *
 * 1. work-sessions:close-stale (withoutOverlapping: dilewati kalau putaran
 *    sebelumnya belum selesai),
 * 2. rekaman Live Kerja: potong per jam & hapus yang lewat masa simpan
 *    (lihat app/services/recording.ts; tidak melakukan apa pun kalau rekaman mati),
 * 3. jadwal briefing: pengingat, buka tepat waktu, tutup otomatis,
 * 4. peringatan kerja & laporan harian/mingguan ke Telegram,
 * 5. detak scheduler (ditulis langsung),
 * 6. job detak antrean (baru tercatat kalau queue worker memprosesnya).
 */
export default class SchedulerRun extends BaseCommand {
    static commandName = 'scheduler:run'
    static description = 'Menjalankan tugas terjadwal tiap menit (pengganti schedule:work)'

    static options: CommandOptions = {
        startApp: true,
        staysAlive: true,
    }

    #timer: NodeJS.Timeout | null = null
    #closingStale = false
    #runningWork = false
    #stopping = false

    async run() {
        const stop = async () => {
            if (this.#stopping) return
            this.#stopping = true
            if (this.#timer) clearTimeout(this.#timer)
            await closeQueue()
            await this.terminate()
        }
        process.once('SIGTERM', stop)
        process.once('SIGINT', stop)

        this.logger.info('Scheduler berjalan')
        this.#scheduleNext()
    }

    #scheduleNext() {
        if (this.#stopping) return
        this.#timer = setTimeout(() => {
            this.#scheduleNext()
            void this.#tick()
        }, msUntilNextMinute())
    }

    async #tick() {
        if (this.#closingStale) {
            this.logger.warning('work-sessions:close-stale masih berjalan, putaran ini dilewati')
        } else {
            this.#closingStale = true
            try {
                const closed = await closeStaleWorkSessions()
                this.logger.info(`${closed} sesi kerja ditutup karena timeout.`)
            } catch (error) {
                this.logger.error(`work-sessions:close-stale gagal: ${String(error)}`)
            } finally {
                this.#closingStale = false
            }
        }

        try {
            const rotated = await rotateRecordings()
            const pruned = await pruneRecordings()
            if (rotated || pruned)
                this.logger.info(`Rekaman: ${rotated} dipotong per jam, ${pruned} dihapus.`)
        } catch (error) {
            this.logger.error(`Rekaman Live Kerja gagal diproses: ${String(error)}`)
        }

        // Briefing & peringatan kerja: dilewati kalau putaran sebelumnya belum selesai.
        if (!this.#runningWork) {
            this.#runningWork = true
            try {
                const briefings = await runBriefingSchedules()
                if (briefings.started || briefings.ended)
                    this.logger.info(
                        `Briefing terjadwal: ${briefings.started} dibuka, ${briefings.ended} ditutup.`
                    )
            } catch (error) {
                this.logger.error(`Jadwal briefing gagal diproses: ${String(error)}`)
            }
            try {
                const work = await runWorkAlerts()
                if (work.alerts || work.reports)
                    this.logger.info(
                        `Peringatan kerja: ${work.alerts} peringatan, ${work.reports} laporan.`
                    )
            } catch (error) {
                this.logger.error(`Peringatan kerja gagal diproses: ${String(error)}`)
            } finally {
                this.#runningWork = false
            }
        }

        try {
            await recordHeartbeat(SCHEDULER_HEARTBEAT_KEY)
        } catch (error) {
            this.logger.error(`Detak scheduler gagal ditulis: ${String(error)}`)
        }

        try {
            await dispatch(JOB_QUEUE_HEARTBEAT, {})
        } catch (error) {
            this.logger.error(`Job detak antrean gagal dikirim: ${String(error)}`)
        }
    }
}
