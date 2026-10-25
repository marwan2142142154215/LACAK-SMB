/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
    // Node
    NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
    PORT: Env.schema.number(),
    HOST: Env.schema.string({ format: 'host' }),
    LOG_LEVEL: Env.schema.string(),

    // App (kunci enkripsi milik Adonis sendiri)
    APP_KEY: Env.schema.secret(),
    APP_URL: Env.schema.string({ format: 'url', tld: false }),

    // APP_KEY backend-api Laravel ("base64:..."), WAJIB sama persis: dipakai
    // untuk Crypt (2FA secret) & URL bertanda tangan, lihat app/services/laravel.
    LARAVEL_APP_KEY: Env.schema.secret(),
    // Origin URL publik backend (mis. https://api.salahmu.fun) -- bagian dari
    // pesan yang ditandatangani signed URL Laravel.
    LARAVEL_APP_URL: Env.schema.string({ format: 'url', tld: false }),

    // Database: SAMA dengan backend-api (skema masih dikelola Laravel)
    DB_HOST: Env.schema.string({ format: 'host' }),
    DB_PORT: Env.schema.number(),
    DB_USER: Env.schema.string(),
    DB_PASSWORD: Env.schema.string.optional(),
    DB_DATABASE: Env.schema.string(),

    // Redis: cache, rate limit, dan antrean (build APK) -- lihat config/redis.ts
    REDIS_HOST: Env.schema.string({ format: 'host' }),
    REDIS_PORT: Env.schema.number(),
    REDIS_PASSWORD: Env.schema.string.optional(),
})
