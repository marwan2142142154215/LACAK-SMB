/*
|--------------------------------------------------------------------------
| HTTP kernel file
|--------------------------------------------------------------------------
*/

import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

server.errorHandler(() => import('#exceptions/Handler'))

server.use([
    () => import('#middleware/ForceJsonResponseMiddleware'),
    () => import('#middleware/ContainerBindingsMiddleware'),
    () => import('@adonisjs/cors/cors_middleware'),
])

/**
 * Log aktivitas API (RecordApiActivity di backend-api) dipasang untuk SEMUA
 * route yang cocok, termasuk route auth publik, setelah bodyparser (butuh
 * isi permintaan). Ia berjalan sebelum middleware bernama (auth, throttle)
 * tapi membaca ctx.authUser setelah next(), jadi pelaku tetap terlihat.
 */
router.use([
    () => import('@adonisjs/core/bodyparser_middleware'),
    () => import('#middleware/RecordApiActivityMiddleware'),
])

export const middleware = router.named({
    auth: () => import('#middleware/AuthMiddleware'),
    extendToken: () => import('#middleware/ExtendTokenExpiryMiddleware'),
    throttle: () => import('#middleware/ThrottleMiddleware'),
})
