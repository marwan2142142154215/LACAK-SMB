import axios from 'axios'
import log from '#services/log'
import { describeHttpError } from '#services/http_error'

/**
 * Kirim notifikasi langsung ke Telegram saat ada pelanggaran geofence.
 * Gateway yang memegang token bot asli (TELEGRAM_BOT_TOKEN di .env) —
 * telegram_bindings di database HANYA menyimpan referensi ("env:..."),
 * bukan token asli (standar 6.1).
 *
 * `@adonisjs/lucid/services/db` diimpor dinamis di dalam fungsi, bukan di
 * top-level file, dengan alasan sama seperti system_user.ts: modul itu
 * butuh application container sudah boot.
 */
export async function notifyTelegramViolation(
    organizationId: number,
    text: string
): Promise<boolean> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) return false

    const { default: db } = await import('@adonisjs/lucid/services/db')
    const binding = await db
        .from('telegram_bindings')
        .where('organization_id', organizationId)
        .where('is_active', true)
        .first()

    if (!binding) return false

    try {
        const response = await axios.post(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
                chat_id: binding.telegram_chat_id,
                text,
            },
            {
                headers: { 'Content-Type': 'application/json' },
                // Status non-2xx ditangani di bawah supaya yang tercatat hanya kode
                // statusnya -- error Axios membawa URL yang memuat token bot.
                validateStatus: () => true,
            }
        )

        if (response.status < 200 || response.status >= 300) {
            log.error('gagal kirim notifikasi Telegram', { status: response.status })
            return false
        }

        return true
    } catch (error) {
        log.error('gagal kirim notifikasi Telegram', describeHttpError(error))
        return false
    }
}
