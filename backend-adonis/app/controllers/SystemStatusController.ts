import type { HttpContext } from '@adonisjs/core/http'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { snapshot } from '#services/server_status'

/**
 * Status semua layanan server (menu Akses > Status server) -- hanya
 * pemegang permission security.manage (super_admin): isinya detail
 * infrastruktur yang tidak perlu dilihat peran lain.
 */
export default class SystemStatusController {
    async handle(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'security.manage')) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melakukan tindakan ini'))
        }

        return success('Status server', await snapshot())
    }
}
