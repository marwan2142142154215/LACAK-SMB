import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { Exception } from '@adonisjs/core/exceptions'
import redis from '@adonisjs/redis/services/main'

/**
 * Padanan middleware `throttle:max,minutes` Laravel: paling banyak `max`
 * permintaan per `minutes` menit per user (kalau sudah login) atau per
 * alamat IP. Lewat batas -> 429 dengan pesan yang sama (handler.ts).
 *
 * Penghitung dipisah per route (metode + pola URL) dan per user/IP: lalu
 * lintas satu route tidak menghabiskan jatah route lain. Sebelumnya semua route
 * berbagi satu penghitung, sehingga halaman yang polling rutin (mis. Status
 * server) bisa membuat route lain yang batasnya kecil (mis. mulai kerja,
 * 10/menit) ditolak 429 padahal pemakainya wajar.
 *
 * Pemakaian: router.post(...).use(middleware.throttle({ max: 5, minutes: 1 }))
 * Pasang SETELAH middleware auth kalau batasnya per user.
 */
/** Kunci penghitung: siapa (user/IP) + route mana. */
export function throttleKey(who: string, method: string, pattern: string): string {
    return `throttle:${who}:${method.toUpperCase()}:${pattern}`
}

export default class ThrottleMiddleware {
    async handle(ctx: HttpContext, next: NextFn, options: { max: number; minutes: number }) {
        const who = ctx.authUser ? `user:${ctx.authUser.id}` : `ip:${ctx.request.ip()}`
        const key = throttleKey(who, ctx.request.method(), ctx.route?.pattern ?? ctx.request.url())
        const windowSeconds = options.minutes * 60

        // Kunci dibuat BERSAMA masa berlakunya (NX = hanya kalau belum ada), lalu dihitung.
        // Cara lama (INCR lalu EXPIRE) meninggalkan penghitung tanpa masa berlaku kalau
        // proses mati di antara dua perintah itu -> pengguna terblokir selamanya.
        await redis.set(key, 0, 'EX', windowSeconds, 'NX')
        const hits = await redis.incr(key)

        if (hits > options.max) {
            let ttl = await redis.ttl(key)
            if (ttl < 0) {
                await redis.expire(key, windowSeconds)
                ttl = windowSeconds
            }
            const retryAfter = Math.max(ttl, 1)
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
