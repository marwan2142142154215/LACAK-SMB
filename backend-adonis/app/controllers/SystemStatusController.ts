import type { HttpContext } from '@adonisjs/core/http'
import { accessOf, can } from '#services/Access'
import { fail, success } from '#services/ApiResponse'
import { cached } from '#services/ResponseCache'
import { snapshot } from '#services/ServerStatus'

/** Satu hasil pemeriksaan dipakai bersama semua yang membuka halaman, selama 10 detik. */
const SNAPSHOT_CACHE_SECONDS = 10

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

        return success(
            'Status server',
            await cached('server-status', SNAPSHOT_CACHE_SECONDS, snapshot)
        )
    }
}
