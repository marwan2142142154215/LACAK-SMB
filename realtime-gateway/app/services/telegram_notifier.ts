import log from '#services/log'

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
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: binding.telegram_chat_id,
        text,
      }),
    })

    if (!response.ok) {
      log.error('gagal kirim notifikasi Telegram', { status: response.status })
      return false
    }

    return true
  } catch (error) {
    log.error('gagal kirim notifikasi Telegram', { error })
    return false
  }
}
