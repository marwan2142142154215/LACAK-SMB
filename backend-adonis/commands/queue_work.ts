import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import type { Job } from 'bullmq'
import {
    closeQueue,
    JOB_BUILD_APK,
    JOB_QUEUE_HEARTBEAT,
    QUEUE_HEARTBEAT_KEY,
    recordHeartbeat,
    startWorker,
} from '#services/queue'
import { handleBuildApk, type BuildApkPayload } from '#jobs/build_apk_job'

/**
 * Pengganti `php artisan queue:work` (unit systemd lacak-api-worker).
 * Memproses build APK dan job detak antrean: detak hanya tercatat kalau
 * worker benar-benar memproses antrean -- dasar status "Antrean" di halaman
 * Status server (RecordQueueHeartbeat di backend-api).
 */
export default class QueueWork extends BaseCommand {
    static commandName = 'queue:work'
    static description = 'Menjalankan worker antrean (build APK, detak antrean)'

    static options: CommandOptions = {
        startApp: true,
        staysAlive: true,
    }

    async run() {
        const worker = startWorker({
            [JOB_BUILD_APK]: (job) => handleBuildApk(job as Job<BuildApkPayload>),
            [JOB_QUEUE_HEARTBEAT]: () => recordHeartbeat(QUEUE_HEARTBEAT_KEY),
        })

        worker.on('completed', (job) => {
            this.logger.info(`Job ${job.name} #${job.id} selesai`)
        })

        // systemd mengirim SIGTERM saat stop/restart: job yang sedang jalan
        // ditunggu selesai dulu, sama seperti queue:work Laravel.
        let stopping = false
        const stop = async () => {
            if (stopping) return
            stopping = true
            this.logger.info('Menghentikan worker antrean...')
            await worker.close()
            await closeQueue()
            await this.terminate()
        }
        process.once('SIGTERM', stop)
        process.once('SIGINT', stop)

        this.logger.info('Worker antrean berjalan')
    }
}
