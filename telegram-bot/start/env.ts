/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| Divalidasi saat boot supaya bot gagal cepat dengan pesan jelas bila .env
| belum lengkap, bukan baru gagal di tengah percakapan dengan operator.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
    NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
    LOG_LEVEL: Env.schema.string(),

    // Dibutuhkan config/encryption.ts (wajib ada untuk boot AdonisJS).
    // Buat dengan: node ace generate:key
    APP_KEY: Env.schema.secret(),

    // Token dari @BotFather. Disimpan sebagai secret supaya tidak ikut
    // tercetak bila objek env sempat masuk ke log.
    TELEGRAM_BOT_TOKEN: Env.schema.secret(),

    // Backend API (Laravel), termasuk prefix versi, mis. http://host/api/v1
    BACKEND_API_URL: Env.schema.string({ format: 'url', tld: false }),

    // Token akun layanan telegram-bot (php artisan bot:issue-telegram-token)
    BACKEND_API_TOKEN: Env.schema.secret(),
})
