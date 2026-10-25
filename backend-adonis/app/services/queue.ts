import { Queue, Worker, type Job, type JobsOptions } from 'bullmq'
import log from '@adonisjs/core/services/logger'
import redis from '@adonisjs/redis/services/main'
import redisConfig from '#config/redis'

/**
 * Antrean latar belakang (BullMQ di Redis koneksi "queue", config/redis.ts)
 * -- pengganti antrean database Laravel (tabel jobs) + `php artisan
 * queue:work`. Job yang ada sama dengan backend-api: build APK
 * (BuildApkJob) dan detak antrean (RecordQueueHeartbeat).
 *
 * Satu worker memproses satu job sekali jalan (concurrency 1), sama seperti
 * satu proses queue:work: build Gradle berat, tidak boleh dua sekaligus.
 */

export const QUEUE_NAME = 'default'

export const JOB_BUILD_APK = 'build-apk'
export const JOB_QUEUE_HEARTBEAT = 'record-queue-heartbeat'

/** Kunci detak yang dibaca halaman Status server (ServerStatus di backend-api). */
export const SCHEDULER_HEARTBEAT_KEY = 'server-status:scheduler-heartbeat'
export const QUEUE_HEARTBEAT_KEY = 'server-status:queue-heartbeat'

/**
 * $tries = 1: job gagal tidak diulang (build gagal ditandai 'failed' dan
 * pengguna memicu ulang sendiri). Job selesai dibuang seperti antrean
 * database; job gagal disimpan sebentar sebagai pengganti failed_jobs.
 */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
}

function connectionOptions() {
    return { ...redisConfig.connections.queue }
}

let queue: Queue | null = null

/** Dibuat saat pertama dipakai supaya server HTTP tidak membuka koneksi antrean bila tidak perlu. */
export function appQueue(): Queue {
    queue ??= new Queue(QUEUE_NAME, {
        connection: connectionOptions(),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
    })
    return queue
}

export async function dispatch(name: string, data: Record<string, unknown>, options?: JobsOptions) {
    return appQueue().add(name, data, options)
}

export async function closeQueue() {
    await queue?.close()
    queue = null
}

/** Carbon::now()->toIso8601String(): 2026-10-25T03:45:45+00:00. */
export function iso8601Now(now: Date = new Date()): string {
    return now.toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

/** Cache::forever() di backend-api: tanpa kedaluwarsa. */
export async function recordHeartbeat(key: string, now: Date = new Date()) {
    await redis.set(key, iso8601Now(now))
}

export type JobHandlers = Record<string, (job: Job) => Promise<unknown>>

/**
 * Worker antrean (dipakai `node ace queue:work`). Job dengan nama yang tidak
 * dikenal dilempar error supaya tercatat gagal, bukan hilang diam-diam.
 */
export function startWorker(handlers: JobHandlers): Worker {
    const worker = new Worker(
        QUEUE_NAME,
        async (job) => {
            const handler = handlers[job.name]
            if (!handler) {
                throw new Error(`Job antrean tidak dikenal: ${job.name}`)
            }
            return handler(job)
        },
        {
            connection: connectionOptions(),
            concurrency: 1,
            // Build menunggu proses anak (tidak memblokir event loop), jadi
            // lock tetap diperpanjang otomatis selama build 1-5 menit.
            lockDuration: 60_000,
        }
    )

    worker.on('failed', (job, error) => {
        log.error({ job: job?.name, id: job?.id, err: error }, 'Job antrean gagal')
    })
    worker.on('error', (error) => {
        log.error({ err: error }, 'Worker antrean bermasalah')
    })

    return worker
}
