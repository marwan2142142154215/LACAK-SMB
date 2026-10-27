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
    // config('app.name') backend-api -- nama penerbit di aplikasi authenticator 2FA.
    APP_NAME: Env.schema.string.optional(),
    // Awalan token Sanctum (SANCTUM_TOKEN_PREFIX backend-api, biasanya kosong).
    SANCTUM_TOKEN_PREFIX: Env.schema.string.optional(),

    // Database: SAMA dengan backend-api (skema masih dikelola Laravel)
    DB_HOST: Env.schema.string({ format: 'host' }),
    DB_PORT: Env.schema.number(),
    DB_USER: Env.schema.string(),
    DB_PASSWORD: Env.schema.string.optional(),
    DB_DATABASE: Env.schema.string(),

    // LiveKit: sama dengan LIVEKIT_* di backend-api/.env (lihat app/services/livekit.ts)
    LIVEKIT_URL: Env.schema.string(),
    LIVEKIT_API_KEY: Env.schema.string(),
    LIVEKIT_API_SECRET: Env.schema.secret(),
    LIVEKIT_TOKEN_TTL_SECONDS: Env.schema.number.optional(),

    LIVE_HEARTBEAT_TIMEOUT_SECONDS: Env.schema.number.optional(),

    // Zona waktu jam shift, jadwal briefing & laporan (default Asia/Jakarta).
    APP_TIMEZONE: Env.schema.string.optional(),
    // Token bot Telegram untuk peringatan & laporan kerja -- sama dengan
    // TELEGRAM_BOT_TOKEN di realtime-gateway/.env. Kosong = tidak dikirim.
    TELEGRAM_BOT_TOKEN: Env.schema.secret.optional(),

    // Account Center (login email) -- sama dengan ACCOUNTCENTER_* di backend-api/.env
    ACCOUNTCENTER_ENABLED: Env.schema.boolean.optional(),
    ACCOUNTCENTER_URI: Env.schema.string.optional(),
    ACCOUNTCENTER_NAME: Env.schema.string.optional(),
    ACCOUNTCENTER_SECRET: Env.schema.secret.optional(),
    ACCOUNTCENTER_TIMEOUT_MS: Env.schema.number.optional(),

    // Penyimpanan file (lihat app/services/storage.ts). Disk "local" = folder
    // STORAGE_PATH (path absolut di luar folder build). LARAVEL_STORAGE_PATH
    // = nama lama, masih dibaca kalau STORAGE_PATH kosong.
    STORAGE_PATH: Env.schema.string.optional(),
    LARAVEL_STORAGE_PATH: Env.schema.string.optional(),
    DOCUMENTS_DISK: Env.schema.enum.optional(['local', 'spaces'] as const),
    CHAT_IMAGES_DISK: Env.schema.enum.optional(['local', 'spaces'] as const),
    DO_SPACES_KEY: Env.schema.string.optional(),
    DO_SPACES_SECRET: Env.schema.secret.optional(),
    DO_SPACES_REGION: Env.schema.string.optional(),
    DO_SPACES_BUCKET: Env.schema.string.optional(),
    DO_SPACES_ENDPOINT: Env.schema.string.optional(),
    DO_SPACES_URL: Env.schema.string.optional(),

    // Lain-lain dari config/lacaksmb.php backend-api
    LACAKSMB_PUBLIC_GATEWAY_URL: Env.schema.string.optional(),
    LACAKSMB_PUBLIC_BACKEND_API_URL: Env.schema.string.optional(),
    LACAKSMB_STATUS_GATEWAY_URL: Env.schema.string.optional(),
    LACAKSMB_STATUS_LIVEKIT_URL: Env.schema.string.optional(),
    LACAKSMB_STATUS_SYSTEMD_UNITS: Env.schema.string.optional(),
    LACAKSMB_TRACKER_PROJECT_PATH: Env.schema.string.optional(),
    LACAKSMB_MASTER_PROJECT_PATH: Env.schema.string.optional(),
    LACAKSMB_LIVE_PROJECT_PATH: Env.schema.string.optional(),
    LACAKSMB_SERVER_EXE_PATH: Env.schema.string.optional(),
    LACAKSMB_WSL_DISTRO: Env.schema.string.optional(),
    // bash = server Linux, wsl = mesin build Windows. Kosong = otomatis dari OS.
    LACAKSMB_APK_BUILD_RUNNER: Env.schema.enum.optional(['bash', 'wsl'] as const),

    // Redis: cache, rate limit, dan antrean (build APK) -- lihat config/redis.ts
    // Seeder (node ace db:seed / demo:seed-accounts): password awal akun.
    // Kosong = dibuat acak dan dicetak sekali di terminal.
    INITIAL_SUPERADMIN_PASSWORD: Env.schema.secret.optional(),
    FORTUNESMB_SUPERADMIN_PASSWORD: Env.schema.secret.optional(),
    DEMO_ACCOUNTS_PASSWORD: Env.schema.secret.optional(),
    ROOT_PASSWORD: Env.schema.secret.optional(),

    REDIS_HOST: Env.schema.string({ format: 'host' }),
    REDIS_PORT: Env.schema.number(),
    REDIS_PASSWORD: Env.schema.string.optional(),
})
