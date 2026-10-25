import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import { laravelDate, logModelEvent, WORK_SESSION_MORPH } from '#services/activity_log'
import { removeBroadcaster } from '#services/livekit'
import {
    closeSession,
    DISCONNECTED_AFTER_SECONDS,
    openSessions,
    record,
    type WorkSessionRow,
} from '#services/work_presence'

/** lacaksmb.livekit.heartbeat_timeout_seconds di backend-api. */
export const heartbeatTimeoutSeconds = () => env.get('LIVE_HEARTBEAT_TIMEOUT_SECONDS', 120)

/**
 * Isi CloseStaleWorkSessions::handle(): menutup sesi Live Kerja yang
 * heartbeat-nya berhenti (tab ditutup, HP mati, sinyal hilang) supaya daftar
 * "sedang live" dan audit trail tidak berisi sesi yang sebenarnya sudah lama
 * putus. Dipakai command ini dan `scheduler:run` (tiap menit).
 *
 * @returns jumlah sesi yang ditutup karena timeout
 */
export async function closeStaleWorkSessions(now: () => Date = () => new Date()): Promise<number> {
    // Heartbeat telat tapi belum lewat batas tutup -> catat "terputus" sekali
    // (status DISCONNECTED); heartbeat berikutnya mencatat "tersambung lagi"
    // (lihat applyState di work_presence).
    const late: WorkSessionRow[] = await openSessions()
        .whereNull('work_sessions.disconnected_at')
        .where(
            'work_sessions.last_heartbeat_at',
            '<',
            new Date(now().getTime() - DISCONNECTED_AFTER_SECONDS * 1000)
        )
        .orderBy('work_sessions.id')

    for (const session of late) {
        const at = now()
        await db
            .from('work_sessions')
            .where('id', session.id)
            .update({ disconnected_at: at, updated_at: at })
        session.disconnected_at = at
        await record(session.user_id, 'disconnected', session)
    }

    const cutoff = new Date(now().getTime() - heartbeatTimeoutSeconds() * 1000)
    const stale: WorkSessionRow[] = await openSessions()
        .where('work_sessions.last_heartbeat_at', '<', cutoff)
        .orderBy('work_sessions.id')

    let closed = 0
    for (const session of stale) {
        await closeSession(session, 'timeout', 'timeout')
        // WorkSession memakai LogsActivity (logOnly ... ended_at, end_reason,
        // logOnlyDirty). Dari console: tanpa pelaku, IP, dan user agent.
        await logModelEvent(null, {
            event: 'updated',
            subjectType: WORK_SESSION_MORPH,
            subjectId: session.id,
            organizationId: session.organization_id,
            attributes: { ended_at: laravelDate(session.ended_at), end_reason: 'timeout' },
            old: { ended_at: null, end_reason: null },
        })
        await removeBroadcaster(session.organization_id, session.user_id)
        closed++
    }

    return closed
}

export default class CloseStaleWorkSessions extends BaseCommand {
    static commandName = 'work-sessions:close-stale'
    static description = 'Menutup sesi Live Kerja yang tidak mengirim heartbeat lagi'

    static options: CommandOptions = {
        startApp: true,
    }

    async run() {
        const closed = await closeStaleWorkSessions()
        this.logger.info(`${closed} sesi kerja ditutup karena timeout.`)
    }
}
