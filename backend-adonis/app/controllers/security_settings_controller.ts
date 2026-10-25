import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { isTwoFactorRequired, setTwoFactorRequired } from '#services/two_factor_policy'
import { laravelBoolean, laravelInput, laravelMessages } from '#validators/users'

const securitySettingValidator = vine.create({
    two_factor_required: laravelBoolean(),
})

/**
 * Pengaturan keamanan sistem yang bisa diubah dari dashboard -- hanya
 * pemegang permission security.manage (super_admin). Padanan
 * SecuritySettingController di backend-api.
 */
export default class SecuritySettingsController {
    async show(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        return success('Pengaturan keamanan', {
            two_factor_required: await isTwoFactorRequired(),
        })
    }

    async update(ctx: HttpContext) {
        if (!(await canManage(ctx))) return forbidden(ctx)

        const data = await securitySettingValidator.validate(laravelInput(ctx), {
            messagesProvider: laravelMessages,
        })
        const required = data.two_factor_required as boolean

        await setTwoFactorRequired(required, ctx.authUser!.id, ctx)

        return success(
            required
                ? '2FA kembali wajib saat login'
                : '2FA dimatikan: login cukup dengan password',
            { two_factor_required: await isTwoFactorRequired() }
        )
    }
}

async function canManage(ctx: HttpContext) {
    return can(await accessOf(ctx), 'security.manage')
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak berwenang melakukan tindakan ini'))
}
