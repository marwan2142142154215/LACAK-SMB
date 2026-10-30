import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import { errors as vineErrors } from '@vinejs/vine'
import redis from '@adonisjs/redis/services/main'

/**
 * Pesan per kode status, sama dengan backend-api (bootstrap/app.php) supaya
 * dashboard & APK menerima jawaban error yang sama dari kedua backend.
 */
const STATUS_MESSAGES: Record<number, string> = {
    400: 'Bentuk permintaan tidak sesuai',
    401: 'Belum masuk atau token tidak berlaku',
    403: 'Anda tidak berwenang melakukan tindakan ini',
    404: 'Data tidak ditemukan',
    405: 'Metode permintaan tidak didukung untuk alamat ini',
    429: 'Terlalu banyak permintaan, silakan coba lagi beberapa saat lagi',
    503: 'Layanan sedang tidak tersedia, silakan coba lagi nanti',
}

const SERVER_ERROR = 'Terjadi kesalahan pada server, silakan coba lagi nanti'

export default class HttpExceptionHandler extends ExceptionHandler {
    protected debug = !app.inProduction

    async handle(error: unknown, ctx: HttpContext) {
        if (error instanceof vineErrors.E_VALIDATION_ERROR) {
            return ctx.response.status(422).send({
                success: false,
                message: 'Isian tidak lolos validasi',
                errors: validationErrors(error.messages),
            })
        }

        const status = statusOf(error)
        if (status === null) {
            // Detail teknis tidak dibocorkan; tetap dicatat oleh report().
            return ctx.response
                .status(500)
                .send({ success: false, message: SERVER_ERROR, errors: null })
        }

        // Token dicabut karena akun ini login di perangkat lain (satu akun =
        // satu sesi, lihat endOtherSessions di auth_controller.ts).
        if (status === 401 && (await wasReplaced(ctx))) {
            return ctx.response.status(401).send({
                success: false,
                message: 'Sesi Anda berakhir karena akun ini login di perangkat lain.',
                errors: { reason: 'session_replaced' },
            })
        }

        return ctx.response.status(status).send({
            success: false,
            message:
                STATUS_MESSAGES[status] ??
                (status >= 500 ? SERVER_ERROR : 'Permintaan tidak dapat diproses'),
            errors: null,
        })
    }

    async report(error: unknown, ctx: HttpContext) {
        return super.report(error, ctx)
    }
}

/** Penanda auth:replaced_token:<id> (TTL 2 jam) untuk id token Bearer yang dipakai. */
async function wasReplaced(ctx: HttpContext): Promise<boolean> {
    const bearer = ctx.request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? ''
    const tokenId = bearer.trim().split('|')[0]
    if (!/^\d+$/.test(tokenId)) {
        return false
    }
    try {
        return (await redis.exists(`auth:replaced_token:${tokenId}`)) === 1
    } catch {
        // Redis bermasalah: tetap balas 401 biasa, jangan jadi 500.
        return false
    }
}

function statusOf(error: unknown): number | null {
    const status = (error as { status?: unknown } | null)?.status
    return typeof status === 'number' && status >= 400 && status < 600 ? status : null
}

/** Bentuk errors Laravel: { field: [pesan, ...] }. */
function validationErrors(messages: Array<{ field: string; message: string }>) {
    const errors: Record<string, string[]> = {}
    for (const { field, message } of messages) {
        ;(errors[field] ??= []).push(message)
    }
    return errors
}
