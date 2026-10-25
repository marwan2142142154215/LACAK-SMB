import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { Exception } from '@adonisjs/core/exceptions'
import redis from '@adonisjs/redis/services/main'

/**
 * Padanan middleware `throttle:max,minutes` Laravel: paling banyak `max`
 * permintaan per `minutes` menit per user (kalau sudah login) atau per
 * alamat IP. Lewat batas -> 429 dengan pesan yang sama (handler.ts).
 *
 * Sama dengan ThrottleRequests Laravel (tanpa limiter bernama), kuncinya
 * TIDAK memuat route: semua route ber-throttle berbagi satu penghitung per
 * user/IP, dan tiap route membandingkannya dengan batasnya sendiri.
 *
 * Pemakaian: router.post(...).use(middleware.throttle({ max: 5, minutes: 1 }))
 * Pasang SETELAH middleware auth kalau batasnya per user.
 */
export default class ThrottleMiddleware {
    async handle(ctx: HttpContext, next: NextFn, options: { max: number; minutes: number }) {
        const who = ctx.authUser ? `user:${ctx.authUser.id}` : `ip:${ctx.request.ip()}`
        const key = `throttle:${who}`

        const hits = await redis.incr(key)
        if (hits === 1) {
            await redis.expire(key, options.minutes * 60)
        }

        if (hits > options.max) {
            const retryAfter = Math.max(await redis.ttl(key), 1)
            ctx.response.header('Retry-After', String(retryAfter))
            throw new Exception('Terlalu banyak permintaan', {
                status: 429,
                code: 'E_TOO_MANY_REQUESTS',
            })
        }

        ctx.response.header('X-RateLimit-Limit', String(options.max))
        ctx.response.header('X-RateLimit-Remaining', String(Math.max(options.max - hits, 0)))
        return next()
    }
}
