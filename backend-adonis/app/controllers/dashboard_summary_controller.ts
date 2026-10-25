import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf } from '#services/access'
import { fail, success } from '#services/api_response'
import { organizationFilter } from '#services/organization_scope'

/**
 * Angka ringkas strip telemetri dashboard -- padanan DashboardSummaryController
 * di backend-api: super_admin semua site, admin/leader site yang diberikan,
 * peran lain site miliknya.
 */
export default class DashboardSummaryController {
    async show(ctx: HttpContext) {
        const filter = organizationFilter(await accessOf(ctx))
        if (filter === null) {
            return ctx.response.status(403).send(fail('Tidak ada site yang bisa diakses'))
        }

        const scoped = (table: string, column = 'organization_id') => {
            const query = db.from(table)
            if (filter !== 'all') query.whereIn(column, filter)
            return query
        }
        const devices = () => scoped('devices').whereNull('deleted_at')
        const apkBuilds = () => scoped('apk_builds')
        const countOf = async (query: ReturnType<typeof scoped>) => {
            const row = await query.count('* as total').first()
            return Number(row?.total ?? 0)
        }
        const totalsBy = async (query: ReturnType<typeof scoped>, column: string) => {
            const rows = await query.select(column).count('* as total').groupBy(column)
            return Object.fromEntries(rows.map((row) => [row[column], Number(row.total)]))
        }

        const [organizations, devicesCount, devicesByStatus, apkCount, apkByType, apkSuccess] =
            await Promise.all([
                countOf(scoped('organizations', 'id').whereNull('deleted_at')),
                countOf(devices()),
                totalsBy(devices(), 'status'),
                countOf(apkBuilds()),
                totalsBy(apkBuilds(), 'apk_type'),
                countOf(apkBuilds().where('status', 'success')),
            ])

        return success('Ringkasan dashboard', {
            organizations_count: organizations,
            devices_count: devicesCount,
            devices_by_status: devicesByStatus,
            apk_builds_count: apkCount,
            apk_builds_by_type: apkByType,
            apk_builds_success_count: apkSuccess,
        })
    }
}
