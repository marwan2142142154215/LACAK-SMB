/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| Gateway ini sengaja tidak punya route login/signup sendiri: semua login
| wajib lewat backend-api Laravel (Sanctum + 2FA), dan gateway hanya
| memvalidasi Bearer token dengan memanggil balik GET /api/v1/auth/me ke
| Laravel (lihat app/services/backend_api_client.ts dan start/socket.ts
| namespace /ops).
|
*/

import router from '@adonisjs/core/services/router'

router.get('/', () => {
    return {
        success: true,
        message: 'Layanan berjalan',
        data: { status: 'ok', service: 'realtime-gateway' },
    }
})
