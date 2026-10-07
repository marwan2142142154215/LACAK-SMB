/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  // Node
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  // App
  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),

  // Session
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'database'] as const),

  // Database (shared dengan backend-api Laravel — lihat config/database.ts)
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),

  // Backend API (Laravel) — dipanggil gateway untuk validasi token Sanctum
  // milik dashboard/APK master (lihat app/services/backend_api_client.ts)
  BACKEND_API_URL: Env.schema.string({ format: 'url', tld: false }),

  // Interval (ms) polling device_commands yang masih 'pending' untuk dikirim
  // ke device yang sedang terkoneksi (lihat app/services/command_dispatcher.ts)
  COMMAND_POLL_INTERVAL_MS: Env.schema.number.optional(),
})
