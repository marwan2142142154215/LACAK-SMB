import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import { errors as vineErrors } from '@vinejs/vine'

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
