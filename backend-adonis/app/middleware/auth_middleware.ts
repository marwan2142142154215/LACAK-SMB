import { DateTime } from 'luxon'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import PersonalAccessToken from '#models/personal_access_token'
import User from '#models/user'
import UnauthenticatedException from '#exceptions/unauthenticated_exception'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { parseSanctumToken, sanctumHashMatches } from '#services/laravel/sanctum_token'

/**
 * Padanan `auth:sanctum`: token Bearer yang diterbitkan backend-api Laravel
 * tetap berlaku di sini (dan sebaliknya), jadi tidak ada yang perlu login
 * ulang selama migrasi. Mengisi ctx.authUser & ctx.accessToken.
 */
export default class AuthMiddleware {
    async handle(ctx: HttpContext, next: NextFn) {
        const bearer = ctx.request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
        const parsed = bearer ? parseSanctumToken(bearer.trim()) : null
        if (!parsed) {
            throw new UnauthenticatedException()
        }

        const accessToken = await (parsed.id === null
            ? PersonalAccessToken.query().where('token', parsed.hash).first()
            : PersonalAccessToken.find(parsed.id))

        if (
            !accessToken ||
            !sanctumHashMatches(accessToken.token, parsed.hash) ||
            accessToken.isExpired ||
            accessToken.tokenableType !== LARAVEL_USER_MORPH
        ) {
            throw new UnauthenticatedException()
        }

        const user = await User.query()
            .withScopes((scopes) => scopes.withoutTrashed())
            .where('id', accessToken.tokenableId)
            .first()
        if (!user) {
            throw new UnauthenticatedException()
        }

        // Sanctum mencatat last_used_at di setiap request terautentikasi.
        accessToken.lastUsedAt = DateTime.now()
        await accessToken.save()

        ctx.authUser = user
        ctx.accessToken = accessToken
        return next()
    }
}

declare module '@adonisjs/core/http' {
    interface HttpContext {
        authUser?: User
        accessToken?: PersonalAccessToken
    }
}
