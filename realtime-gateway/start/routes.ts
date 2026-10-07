/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| TIDAK DIPAKAI secara sengaja: route signup/login/profile di bawah ini
| adalah bawaan starter kit "api" AdonisJS (auth berbasis tabel `users` dan
| `access_tokens` milik Lucid sendiri). Gateway ini TIDAK memakai jalur
| auth itu — semua login wajib lewat backend-api Laravel (Sanctum + 2FA),
| dan gateway hanya memvalidasi Bearer token dengan memanggil balik
| GET /api/v1/auth/me ke Laravel (lihat app/services/backend_api_client.ts
| dan start/socket.ts namespace /ops).
|
| Route & controller bawaan ini sengaja dibiarkan (bukan dihapus total, demi
| menghindari pembongkaran besar paket @adonisjs/auth yang berisiko di
| tengah sesi) tapi migration tabel `users`/`access_tokens` miliknya SUDAH
| DIHAPUS (lihat database/migrations) karena akan bentrok dengan tabel
| `users` milik Laravel di database yang sama. Jangan jalankan endpoint
| /api/v1/auth/signup atau /api/v1/auth/login DI GATEWAY INI — itu bukan
| sistem auth yang sesungguhnya dipakai.
|
*/

import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'
import { controllers } from '#generated/controllers'

router.get('/', () => {
  return { status: 'ok', service: 'realtime-gateway' }
})

router
  .group(() => {
    router
      .group(() => {
        router.post('signup', [controllers.NewAccount, 'store'])
        router.post('login', [controllers.AccessTokens, 'store'])
      })
      .prefix('auth')
      .as('auth')

    router
      .group(() => {
        router.get('profile', [controllers.Profile, 'show'])
        router.post('logout', [controllers.AccessTokens, 'destroy'])
      })
      .prefix('account')
      .as('profile')
      .use(middleware.auth())
  })
  .prefix('/_unused_starter_kit_auth')
