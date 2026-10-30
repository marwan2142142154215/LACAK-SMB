import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'
import { accessOf } from '#services/access'
import { writeActivity } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import { attendanceReport, staffOfSites } from '#services/attendance'
import { DATE_PATTERN, datesBetween, localDate, TIME_PATTERN } from '#services/local_time'
import { isManager, managedSites, managesSite } from '#services/managed_sites'
import { telegramEnabled } from '#services/telegram'
import { ALERT_TYPE_LABELS, DEFAULT_SETTINGS, settingsFor } from '#services/work_alerts'
import { sitesOf } from '#controllers/work_shifts_controller'

/** Rentang rekap absensi maksimal (hari). */
const MAX_DAYS = 62

const rangeValidator = vine.compile(
    vine.object({
        from: vine.string().regex(DATE_PATTERN),
        to: vine.string().regex(DATE_PATTERN),
        organization_id: vine.number().withoutDecimals().positive().optional(),
    })
)

const settingsValidator = vine.compile(
    vine.object({
        alerts_enabled: vine.boolean(),
        camera_off_minutes: vine.number().withoutDecimals().min(1).max(240),
        face_missing_minutes: vine.number().withoutDecimals().min(5).max(240),
        absent_alert: vine.boolean(),
        daily_report: vine.boolean(),
        weekly_report: vine.boolean(),
        report_time: vine.string().regex(TIME_PATTERN),
    })
)

/**
 * Rekap absensi (dari Live Kerja + shift + izin), daftar peringatan kerja,
 * dan pengaturan peringatan & laporan Telegram per site.
 */
export default class AttendanceController {
    /** Rekap per staf per hari. Pengelola: site yang dipilih; staf: dirinya sendiri. */
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const input = await ctx.request.validateUsing(rangeValidator, {
            data: ctx.request.qs(),
        })
        if (input.to < input.from) {
            return ctx.response.status(422).send(fail('Tanggal akhir harus setelah tanggal awal'))
        }
        if (datesBetween(input.from, input.to).length > MAX_DAYS) {
            return ctx.response.status(422).send(fail(`Rentang rekap maksimal ${MAX_DAYS} hari`))
        }

        const manager = isManager(access)
        const sites = manager ? await sitesOf(managedSites(access)) : []
        let staff
        let organizationId: number | null = null
        if (manager) {
            organizationId = input.organization_id ?? sites[0]?.id ?? null
            if (organizationId === null) {
                return success('Rekap absensi', { sites, organization_id: null, items: [] })
            }
            if (!managesSite(access, organizationId)) {
                return ctx.response.status(403).send(fail('Anda tidak mengelola site ini'))
            }
            staff = await staffOfSites([organizationId])
        } else {
            const me = ctx.authUser!
            staff = [{ id: me.id, name: me.name, organization_id: me.organizationId }]
        }

        return success('Rekap absensi', {
            sites,
            can_manage: manager,
            organization_id: organizationId,
            today: localDate(),
            items: await attendanceReport(staff, input.from, input.to),
        })
    }

    /** Peringatan & laporan yang tercatat di site yang dikelola. */
    async alerts(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!isManager(access)) return forbidden(ctx)

        const requested = Number(ctx.request.input('organization_id')) || null
        if (requested && !managesSite(access, requested)) return forbidden(ctx)
        const own = managedSites(access)
        const type = ctx.request.input('type')

        const rows = await db
            .from('work_alerts')
            .leftJoin('organizations', 'organizations.id', 'work_alerts.organization_id')
            .if(requested !== null, (query) =>
                query.where('work_alerts.organization_id', requested!)
            )
            .if(requested === null && own !== 'all', (query) =>
                query.whereIn('work_alerts.organization_id', own as number[])
            )
            .if(typeof type === 'string' && type in ALERT_TYPE_LABELS, (query) =>
                query.where('work_alerts.type', type)
            )
            .orderBy('work_alerts.created_at', 'desc')
            .orderBy('work_alerts.id', 'desc')
            .limit(Math.min(Number(ctx.request.input('limit')) || 100, 300))
            .select('work_alerts.*', 'organizations.name as site_name')

        return success('Peringatan kerja', {
            types: Object.entries(ALERT_TYPE_LABELS).map(([value, label]) => ({ value, label })),
            telegram_enabled: telegramEnabled(),
            items: rows.map((row) => ({
                id: row.id,
                organization_id: row.organization_id,
                site_name: row.site_name,
                user_id: row.user_id,
                type: row.type,
                type_label: ALERT_TYPE_LABELS[row.type] ?? row.type,
                message: row.message,
                sent_telegram: row.sent_telegram,
                created_at: row.created_at,
            })),
        })
    }

    async showSettings(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const organizationId = Number(ctx.params.organizationId)
        if (!managesSite(access, organizationId)) return forbidden(ctx)

        const binding = await db
            .from('telegram_bindings')
            .where('organization_id', organizationId)
            .where('is_active', true)
            .first()
        return success('Pengaturan peringatan kerja', {
            ...(await settingsFor(organizationId)),
            defaults: DEFAULT_SETTINGS,
            telegram_enabled: telegramEnabled(),
            telegram_bound: !!binding,
        })
    }

    async updateSettings(ctx: HttpContext) {
        const access = await accessOf(ctx)
        const organizationId = Number(ctx.params.organizationId)
        if (!managesSite(access, organizationId)) return forbidden(ctx)
        const input = await ctx.request.validateUsing(settingsValidator)

        const now = new Date()
        await db
            .table('work_alert_settings')
            .insert({
                organization_id: organizationId,
                ...input,
                updated_by: access.userId,
                created_at: now,
                updated_at: now,
            })
            .onConflict('organization_id')
            .merge({ ...input, updated_by: access.userId, updated_at: now })
        await writeActivity(ctx, {
            logName: 'work_alerts',
            description: 'Mengubah pengaturan peringatan & laporan kerja',
            event: 'updated',
            subjectType: null,
            subjectId: organizationId,
            properties: input,
            organizationId,
        })
        return success('Pengaturan disimpan', await settingsFor(organizationId))
    }
}

function forbidden(ctx: HttpContext) {
    return ctx.response.status(403).send(fail('Anda tidak mengelola site ini'))
}
