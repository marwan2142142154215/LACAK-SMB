/*
|--------------------------------------------------------------------------
| Route modul auth (Tahap 2) -- didaftarkan dari start/routes.ts
|--------------------------------------------------------------------------
|
| /auth/me & /auth/session sudah ada di start/routes.ts (Tahap 0).
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AuthController = () => import('#controllers/auth_controller')

router
    .group(() => {
        // throttle per-IP sebagai lapis pertama anti brute-force (lapis kedua:
        // hitung percobaan per challenge di controller). /login lebih ketat
        // karena tidak punya batas percobaan per challenge.
        // Halaman depan dashboard: IP di luar whitelist tidak diberi form login.
        router
            .get('/auth/ip-check', [AuthController, 'ipCheck'])
            .use(middleware.throttle({ max: 30, minutes: 1 }))
        router
            .post('/auth/login', [AuthController, 'login'])
            .use(middleware.throttle({ max: 5, minutes: 1 }))
        router
            .post('/auth/2fa/setup/confirm', [AuthController, 'confirmTwoFactorSetup'])
            .use(middleware.throttle({ max: 10, minutes: 1 }))
        router
            .post('/auth/2fa/verify', [AuthController, 'verifyTwoFactor'])
            .use(middleware.throttle({ max: 10, minutes: 1 }))

        router
            .post('/auth/logout', [AuthController, 'logout'])
            .use([middleware.auth(), middleware.extendToken()])
    })
    .prefix('/api/v1')
