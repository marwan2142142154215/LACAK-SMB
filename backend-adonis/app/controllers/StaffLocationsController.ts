import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf, can } from '#services/Access'
import { fail, success } from '#services/ApiResponse'
import { organizationFilter } from '#services/OrganizationScope'
import { staffLocationResource, type StaffLocationRow } from '#services/StaffLocationResource'

/**
 * Lokasi terakhir tiap staf (dari agen HP/desktop lewat gateway) untuk peta Radar
 * & detail staf. Butuh izin `radar.view` -- dipegang leader/admin/site_admin/
 * super_admin -- dan dibatasi ke site yang boleh diakses pelaku (sama dengan radar
 * device). Snapshot awal; pembaruan live lewat socket `staff:location`.
 */
export default class StaffLocationsController {
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'radar.view')) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melakukan tindakan ini'))
        }

        const scope = organizationFilter(access)
        if (scope === null) return ctx.response.send(success('OK', { items: [] }))

        // Lokasi terakhir per staf (distinctOn), hanya user di site yang boleh dilihat.
        const query = db
            .from('staff_locations as sl')
            .join('users as u', 'u.id', 'sl.user_id')
            .whereNull('u.deleted_at')
            .distinctOn('sl.user_id')
            .orderBy('sl.user_id')
            .orderBy('sl.captured_at', 'desc')
            .select('sl.*', 'u.name as user_name', 'u.organization_id as user_org')
        if (scope !== 'all') query.whereIn('u.organization_id', scope)

        const rows = (await query) as (StaffLocationRow & {
            user_name: string
            user_org: number | null
        })[]
        const items = rows.map((row) => ({
            user_id: row.user_id,
            user_name: row.user_name,
            organization_id: row.user_org,
            last_location: staffLocationResource(row),
        }))
        return ctx.response.send(success('OK', { items }))
    }
}
