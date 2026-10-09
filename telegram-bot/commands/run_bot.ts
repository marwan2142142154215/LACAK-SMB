import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class RunBot extends BaseCommand {
    static commandName = 'bot:run'
    static description = 'Menjalankan bot Telegram Lacak Master (long polling)'

    static options: CommandOptions = {
        startApp: true,
    }

    async run() {
        // Diimpor di dalam run(), bukan di top-level: modul-modul ini membaca env
        // dan logger yang baru siap setelah aplikasi selesai boot (startApp).
        const { default: env } = await import('#start/env')
        const { createTelegramBot } = await import('#services/telegram_bot')
        const { run } = await import('node-telegram-bot-api/node')
        const logger = await this.app.container.make('logger')

        const bot = createTelegramBot(env.get('TELEGRAM_BOT_TOKEN').release(), logger)

        logger.info('Lacak Master Telegram bot berjalan (polling)')
        // run() memasang handler SIGINT/SIGTERM yang menghentikan polling dengan
        // rapi, lalu resolve -- setelah itu Ace menutup aplikasi seperti biasa.
        await run(bot)
        logger.info('Polling bot Telegram dihentikan')
    }
}
