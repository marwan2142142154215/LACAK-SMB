import type { Logger } from '@adonisjs/core/logger'

type LogMeta = Record<string, unknown>

/**
 * Pembungkus logger AdonisJS untuk kode gateway custom (socket.ts,
 * command_dispatcher.ts, ...).
 *
 * `@adonisjs/core/services/logger` sengaja diimpor dinamis saat pertama kali
 * dipakai, bukan di top-level file: modul itu memakai top-level `await
 * app.booted(...)` yang butuh application container sudah dibuat, sedangkan
 * file-file ini sudah diimpor bin/server.ts sebelum Ignitor membuat app.
 * Pemanggilan log sendiri baru terjadi saat runtime, setelah boot selesai.
 */
let loggerPromise: Promise<Logger> | null = null

function getLogger(): Promise<Logger> {
    loggerPromise ??= import('@adonisjs/core/services/logger').then(({ default: logger }) => logger)
    return loggerPromise
}

/**
 * Pino hanya menyerialisasi objek Error yang diletakkan di kunci `err`;
 * pemanggil di gateway ini memakai kunci `error`, yang tanpa dipindah akan
 * tercatat sebagai `{}` dan kehilangan pesan serta stack trace.
 */
function toMergingObject(meta?: LogMeta): LogMeta {
    if (!meta) return {}

    const { error, ...rest } = meta
    return error === undefined ? rest : { ...rest, err: error }
}

function write(level: 'info' | 'warn' | 'error', message: string, meta?: LogMeta) {
    getLogger()
        .then((logger) => logger[level](toMergingObject(meta), message))
        .catch((loggerError: unknown) => {
            // Logger sendiri gagal dimuat -- tidak ada logger lain untuk
            // mencatatnya, jadi tulis langsung ke stderr agar tidak hilang.
            process.stderr.write(
                `gagal memuat logger AdonisJS (${String(loggerError)}); pesan: ${message}\n`
            )
        })
}

export default {
    info(message: string, meta?: LogMeta) {
        write('info', message, meta)
    },
    warn(message: string, meta?: LogMeta) {
        write('warn', message, meta)
    },
    error(message: string, meta?: LogMeta) {
        write('error', message, meta)
    },
}
