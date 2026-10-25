import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import log from '@adonisjs/core/services/logger'
import { accessOf, can } from '#services/access'
import { writeActivity } from '#services/activity_log'
import { fail, success } from '#services/api_response'
import { authorizedOrganizationId } from '#services/organization_scope'
import {
    handleEgressEnded,
    handleTrackPublished,
    RECORDING_RETENTION_HOURS,
    recordingEnabled,
    verifyWebhook,
} from '#services/recording'
import { disk } from '#services/storage'

// Tautan putar ulang berlaku selama ini (cukup untuk menonton satu file 1 jam).
const PLAYBACK_URL_TTL_SECONDS = 2 * 3600

export default class LiveRecordingsController {
    /**
     * Rekaman kamera & layar satu staf dalam rentang waktu (maks. masa simpan).
     * GET /live/recordings?user_id=&from=&to=  (from/to ISO 8601)
     */
    async index(ctx: HttpContext) {
        const access = await accessOf(ctx)
        if (!can(access, 'live.watch')) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melakukan tindakan ini'))
        }

        const enabled = recordingEnabled()
        const userId = Number(ctx.request.input('user_id'))
        if (!Number.isInteger(userId) || userId <= 0) {
            return ctx.response.status(422).send(fail('user_id wajib diisi'))
        }

        const staff = await db.from('users').where('id', userId).whereNull('deleted_at').first()
        if (
            !staff ||
            authorizedOrganizationId(access, staff.organization_id) !== staff.organization_id
        ) {
            return ctx.response
                .status(403)
                .send(fail('Anda tidak berwenang melihat rekaman staf ini'))
        }

        const now = Date.now()
        const oldest = now - RECORDING_RETENTION_HOURS * 3_600_000
        const from = Math.max(Date.parse(ctx.request.input('from') ?? '') || oldest, oldest)
        const to = Math.min(Date.parse(ctx.request.input('to') ?? '') || now, now)

        const rows = await db
            .from('live_recordings')
            .where('user_id', userId)
            .where('started_at', '<', new Date(to))
            .where((query) => query.whereNull('ended_at').orWhere('ended_at', '>=', new Date(from)))
            .orderBy('started_at', 'asc')

        const items = await Promise.all(
            rows.map(async (row) => {
                let url: string | null = null
                if (enabled && row.status === 'completed' && row.file_path) {
                    try {
                        url = await disk('spaces').temporaryUrl(row.file_path, {
                            expiresInSeconds: PLAYBACK_URL_TTL_SECONDS,
                            responseContentType: 'video/webm',
                        })
                    } catch (error) {
                        log.warn({ err: error, id: row.id }, 'Gagal membuat tautan rekaman')
                    }
                }
                return {
                    id: row.id,
                    source: row.source,
                    status: row.status,
                    started_at: row.started_at,
                    ended_at: row.ended_at,
                    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
                    url,
                }
            })
        )

        // Siapa memutar rekaman siapa -- tercatat di Log aktivitas.
        await writeActivity(ctx, {
            logName: 'live_recordings',
            description: 'Melihat rekaman Live Kerja',
            event: 'viewed',
            subjectType: null,
            subjectId: null,
            properties: {
                staff_user_id: userId,
                from: new Date(from).toISOString(),
                to: new Date(to).toISOString(),
            },
            organizationId: staff.organization_id,
        })

        return success('Rekaman Live Kerja', {
            enabled,
            retention_hours: RECORDING_RETENTION_HOURS,
            items,
        })
    }

    /**
     * Webhook LiveKit (tanpa login; diverifikasi tanda tangan API secret).
     * Hanya bekerja kalau rekaman aktif (Spaces terisi).
     */
    async webhook(ctx: HttpContext) {
        const raw = ctx.request.raw() ?? ''
        if (!verifyWebhook(raw, ctx.request.header('authorization'))) {
            return ctx.response.status(401).send(fail('Tanda tangan webhook tidak sah'))
        }
        if (!recordingEnabled()) return success('Rekaman tidak aktif')

        let event: Record<string, unknown>
        try {
            event = JSON.parse(raw)
        } catch {
            return ctx.response.status(400).send(fail('Body webhook tidak valid'))
        }

        try {
            if (event.event === 'track_published') await handleTrackPublished(event)
            else if (event.event === 'egress_ended') await handleEgressEnded(event)
        } catch (error) {
            log.error({ err: error, event: event.event }, 'Webhook LiveKit gagal diproses')
        }
        return success('OK')
    }
}
