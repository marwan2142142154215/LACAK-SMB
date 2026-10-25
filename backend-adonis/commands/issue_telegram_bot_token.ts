import { createHash, randomBytes } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

export const TELEGRAM_BOT_TOKEN_NAME = 'telegram-bot-service'

/**
 * HasApiTokens::generateTokenString() Sanctum: awalan (SANCTUM_TOKEN_PREFIX)
 * + Str::random(40) + crc32b dari 40 karakter itu (heksadesimal).
 */
export function generateSanctumTokenString(prefix: string = ''): string {
    let entropy = ''
    while (entropy.length < 40) {
        entropy += randomBytes(40).toString('base64').replace(/[/+=]/g, '')
    }
    entropy = entropy.slice(0, 40)
    return `${prefix}${entropy}${crc32b(entropy)}`
}

/** hash('crc32b', $text) PHP: 8 digit heksadesimal. */
export function crc32b(text: string): string {
    return crc32(Buffer.from(text, 'utf8')).toString(16).padStart(8, '0')
}

/**
 * Menerbitkan Bearer token untuk akun layanan telegram-bot (padanan
 * IssueTelegramBotToken). Token lama (nama sama) dicabut dulu supaya tidak
 * ada token lama yang menggantung tanpa diketahui bot-nya sendiri. Tanpa
 * expires_at: token akun layanan tidak kena idle timeout.
 *
 * Token HANYA ditampilkan sekali di sini -- operator menyalin ke
 * telegram-bot/.env (BACKEND_API_TOKEN), tidak pernah disimpan di tempat
 * lain (standar 6.1: kredensial sistem tidak boleh lewat chat/log).
 */
export default class IssueTelegramBotToken extends BaseCommand {
    static commandName = 'bot:issue-telegram-token'
    static description = 'Menerbitkan Bearer token baru untuk akun layanan telegram-bot'

    static options: CommandOptions = {
        startApp: true,
    }

    async run() {
        const bot = await db
            .from('users')
            .where('username', 'telegram-bot')
            .whereNull('deleted_at')
            .select('id')
            .first()

        if (!bot) {
            this.logger.error('Akun telegram-bot belum ada. Jalankan "php artisan db:seed" dulu.')
            this.exitCode = 1
            return
        }

        const plainTextToken = generateSanctumTokenString(env.get('SANCTUM_TOKEN_PREFIX') ?? '')
        const now = new Date()

        const id = await db.transaction(async (trx) => {
            await trx
                .from('personal_access_tokens')
                .where('tokenable_type', LARAVEL_USER_MORPH)
                .where('tokenable_id', bot.id)
                .where('name', TELEGRAM_BOT_TOKEN_NAME)
                .delete()

            const [row] = await trx
                .table('personal_access_tokens')
                .insert({
                    tokenable_type: LARAVEL_USER_MORPH,
                    tokenable_id: bot.id,
                    name: TELEGRAM_BOT_TOKEN_NAME,
                    token: createHash('sha256').update(plainTextToken).digest('hex'),
                    abilities: JSON.stringify(['*']),
                    expires_at: null,
                    created_at: now,
                    updated_at: now,
                })
                .returning(['id'])
            return row.id as number
        })

        this.logger.log('')
        this.logger.log(
            'Token berhasil dibuat. Salin ke telegram-bot/.env sebagai BACKEND_API_TOKEN:'
        )
        this.logger.log('')
        this.logger.log(`${id}|${plainTextToken}`)
        this.logger.log('')
        this.logger.warning(
            'Token ini tidak akan ditampilkan lagi. Jangan dikirim lewat chat/WhatsApp.'
        )
    }
}
