import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { accessOf } from '#services/access'
import { fail, success } from '#services/api_response'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
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

        // Staf = user yang boleh Live Kerja (izin live.broadcast, langsung atau
        // lewat peran), aktif, tidak dihapus -- sama dengan roster Live Kerja.
        const staff = () =>
            scoped('users')
                .where('is_active', true)
                .whereNull('deleted_at')
                .where((query) => {
                    const permissionId = db
                        .from('permissions')
                        .where('name', 'live.broadcast')
                        .select('id')
                    query
                        .whereIn(
                            'id',
                            db
                                .from('model_has_permissions')
                                .where('model_type', LARAVEL_USER_MORPH)
                                .whereIn('permission_id', permissionId)
                                .select('model_id')
                        )
                        .orWhereIn(
                            'id',
                            db
                                .from('model_has_roles')
                                .join(
                                    'role_has_permissions',
                                    'role_has_permissions.role_id',
                                    'model_has_roles.role_id'
                                )
                                .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
                                .whereIn('role_has_permissions.permission_id', permissionId)
                                .select('model_has_roles.model_id')
                        )
                })
        // Online = masih punya token login berlaku (status Online / sedang
        // kerja di daftar staf); token login selalu punya expires_at.
        const staffOnline = () =>
            staff().whereIn(
                'id',
                db
                    .from('personal_access_tokens')
                    .where('tokenable_type', LARAVEL_USER_MORPH)
                    .where('expires_at', '>', new Date())
                    .select('tokenable_id')
            )

        const [
            organizations,
            devicesCount,
            devicesByStatus,
            apkCount,
            apkByType,
            apkSuccess,
            staffCount,
            staffOnlineCount,
        ] = await Promise.all([
            countOf(scoped('organizations', 'id').whereNull('deleted_at')),
            countOf(devices()),
            totalsBy(devices(), 'status'),
            countOf(apkBuilds()),
            totalsBy(apkBuilds(), 'apk_type'),
            countOf(apkBuilds().where('status', 'success')),
            countOf(staff()),
            countOf(staffOnline()),
        ])

        return success('Ringkasan dashboard', {
            organizations_count: organizations,
            devices_count: devicesCount,
            devices_by_status: devicesByStatus,
            apk_builds_count: apkCount,
            apk_builds_by_type: apkByType,
            apk_builds_success_count: apkSuccess,
            staff_count: staffCount,
            staff_online_count: staffOnlineCount,
        })
    }
}
