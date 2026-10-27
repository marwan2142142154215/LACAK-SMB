import db from '@adonisjs/lucid/services/db'
import log from '@adonisjs/core/services/logger'
import env from '#start/env'

/**
 * Kirim pesan ke chat Telegram yang diikat ke site (telegram_bindings) --
 * dipakai peringatan & laporan kerja. Token bot asli hanya ada di .env
 * (TELEGRAM_BOT_TOKEN, sama dengan realtime-gateway); kosong = tidak dikirim.
 */
export function telegramEnabled(): boolean {
    return !!env.get('TELEGRAM_BOT_TOKEN')?.release()
}

export async function sendTelegram(chatId: string, text: string): Promise<boolean> {
    const token = env.get('TELEGRAM_BOT_TOKEN')?.release()
    if (!token) return false
    try {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(10_000),
        })
        // Hanya kode status yang dicatat -- URL memuat token bot.
        if (!response.ok) log.warn({ status: response.status }, 'Pesan Telegram gagal dikirim')
        return response.ok
    } catch (error) {
        log.warn({ reason: (error as Error).name }, 'Telegram tidak bisa dihubungi')
        return false
    }
}

/** Kirim ke semua chat aktif yang diikat ke site ini. */
export async function sendToSite(organizationId: number, text: string): Promise<boolean> {
    if (!telegramEnabled()) return false
    const bindings = await db
        .from('telegram_bindings')
        .where('organization_id', organizationId)
        .where('is_active', true)
        .select('telegram_chat_id')
    let sent = false
    for (const binding of bindings) {
        if (await sendTelegram(String(binding.telegram_chat_id), text)) sent = true
    }
    return sent
}
