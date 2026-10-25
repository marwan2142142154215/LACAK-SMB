import { DateTime } from 'luxon'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/** Idle timeout token login (AuthController::TOKEN_IDLE_HOURS di backend-api). */
export const TOKEN_IDLE_HOURS = 2

/**
 * Padanan ExtendTokenExpiry: tiap request terautentikasi menggeser expires_at
 * token login 2 jam ke depan. Token akun layanan (expires_at null) dibiarkan
 * tanpa batas. Pasang SETELAH middleware auth.
 */
export default class ExtendTokenExpiryMiddleware {
    async handle(ctx: HttpContext, next: NextFn) {
        const output = await next()

        const token = ctx.accessToken
        if (token && token.expiresAt) {
            token.expiresAt = DateTime.now().plus({ hours: TOKEN_IDLE_HOURS })
            await token.save()
        }

        return output
    }
}
