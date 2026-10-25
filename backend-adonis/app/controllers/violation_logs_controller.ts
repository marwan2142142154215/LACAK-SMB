import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/access'
import { fail, success } from '#services/api_response'
import { authorizedOrganizationId } from '#services/organization_scope'
import { findDeviceOrFail, paginate, violationLogResource } from '#services/device_resource'

/**
 * Read-only dari sisi API ini, padanan ViolationLogController di backend-api.
 * Pencatatan violation_logs yang sebenarnya (deteksi WiFi/IP di luar
 * whitelist) dibuat oleh realtime-gateway saat device melapor.
 */
export default class ViolationLogsController {
    async index(ctx: HttpContext) {
        const device = await findDeviceOrFail(ctx.params.device)
        const access = await accessOf(ctx)
        if (!can(access, 'devices.view')) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melakukan tindakan ini'))
        }

        if (authorizedOrganizationId(access, device.organization_id) === null) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melihat log pelanggaran device ini'))
        }

        const { rows, total } = await paginate(ctx, () =>
            db
                .from('violation_logs')
                .where('device_id', device.id)
                .orderBy('detected_at', 'desc')
                .select('*')
        )

        return success('Log pelanggaran geofence', { items: rows.map(violationLogResource), total })
    }
}
