import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import log from '@adonisjs/core/services/logger'
import env from '#start/env'
import { issue, liveKitConfig, roomForOrganization } from '#services/livekit'
import { disk } from '#services/storage'
import { openSessionOf } from '#services/work_presence'

/**
 * Rekaman video penuh Live Kerja lewat LiveKit Egress (Track Egress: tiap
 * track kamera & layar staf direkam apa adanya tanpa transcoding, langsung
 * diunggah ke DigitalOcean Spaces).
 *
 * Alurnya digerakkan webhook LiveKit (POST /api/v1/livekit/webhook):
 * - track_published (kamera/layar staf) -> StartTrackEgress + baris live_recordings
 * - egress_ended -> baris ditandai selesai/gagal; kalau dihentikan karena
 *   pergantian jam (rotateRecordings), langsung direkam lagi -> file per jam.
 * Scheduler tiap menit: rotateRecordings() & pruneRecordings() (hapus > 72 jam).
 *
 * Rekaman MATI kalau Spaces (DO_SPACES_KEY/SECRET/BUCKET) belum diisi.
 */

export const RECORDING_RETENTION_HOURS = 72
export const RECORDING_SEGMENT_MINUTES = 60
export const RECORDING_SOURCES = ['camera', 'screen_share'] as const
export type RecordingSource = (typeof RECORDING_SOURCES)[number]

export function recordingEnabled(): boolean {
    return Boolean(
        env.get('DO_SPACES_KEY') &&
        env.get('DO_SPACES_SECRET')?.release() &&
        env.get('DO_SPACES_BUCKET') &&
        env.get('LIVEKIT_API_KEY') &&
        env.get('LIVEKIT_API_SECRET')?.release()
    )
}

function spacesUpload() {
    const region = env.get('DO_SPACES_REGION') || 'sgp1'
    return {
        access_key: env.get('DO_SPACES_KEY'),
        secret: env.get('DO_SPACES_SECRET')?.release(),
        region,
        endpoint: env.get('DO_SPACES_ENDPOINT') || `https://${region}.digitaloceanspaces.com`,
        bucket: env.get('DO_SPACES_BUCKET'),
    }
}

/** Panggil API Egress LiveKit (Twirp JSON) dengan token roomRecord. */
async function egressApi(method: string, body: Record<string, unknown>) {
    const config = liveKitConfig()
    const httpUrl = config.url.replace(/\/+$/, '').replace(/^ws(s?):\/\//, 'http$1://')
    const response = await fetch(`${httpUrl}/twirp/livekit.Egress/${method}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${issue('backend-api', 'backend-api', { roomRecord: true }, config)}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
    })
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
        throw new Error(
            `Egress ${method} gagal (${response.status}): ${String(payload?.msg ?? '')}`
        )
    }
    return payload ?? {}
}

/** Path file di Spaces: recordings/{site}/{staf}/{tanggal UTC}/{sumber}-{jam}-{track}.webm */
export function recordingPath(
    organizationId: number,
    userId: number,
    source: RecordingSource,
    trackSid: string,
    at: Date
): string {
    const iso = at.toISOString()
    const day = iso.slice(0, 10)
    const time = iso.slice(11, 19).replaceAll(':', '')
    return `recordings/${organizationId}/${userId}/${day}/${source}-${time}-${trackSid}.webm`
}

/** Mulai merekam satu track kamera/layar staf. Gagal hanya dicatat. */
export async function startTrackRecording(input: {
    organizationId: number
    userId: number
    source: RecordingSource
    trackSid: string
}) {
    if (!recordingEnabled()) return null

    const session = await openSessionOf(input.userId)
    // Rekaman hanya untuk staf yang sedang Mulai kerja di site itu.
    if (!session || session.organization_id !== input.organizationId) return null

    const now = new Date()
    const filepath = recordingPath(
        input.organizationId,
        input.userId,
        input.source,
        input.trackSid,
        now
    )
    try {
        const info = await egressApi('StartTrackEgress', {
            room_name: roomForOrganization(input.organizationId),
            track_id: input.trackSid,
            file: { filepath, s3: spacesUpload() },
        })
        const egressId = String(info.egress_id ?? info.egressId ?? '')
        if (!egressId) throw new Error('Egress tidak mengembalikan egress_id')

        await db.table('live_recordings').insert({
            organization_id: input.organizationId,
            user_id: input.userId,
            work_session_id: session.id,
            egress_id: egressId,
            track_sid: input.trackSid,
            source: input.source,
            status: 'recording',
            file_path: filepath,
            started_at: now,
            created_at: now,
            updated_at: now,
        })
        return egressId
    } catch (error) {
        log.warn({ err: error, ...input }, 'Gagal memulai rekaman Live Kerja')
        return null
    }
}

export async function stopEgress(egressId: string) {
    try {
        await egressApi('StopEgress', { egress_id: egressId })
    } catch (error) {
        log.warn({ err: error, egressId }, 'Gagal menghentikan rekaman Live Kerja')
    }
}

/** Ambil field dari objek webhook (protojson camelCase) atau Twirp (snake_case). */
function field(source: Record<string, unknown> | undefined, ...names: string[]): unknown {
    for (const name of names) {
        if (source && source[name] !== undefined && source[name] !== null) return source[name]
    }
    return undefined
}

/** Webhook track_published: rekam kamera & layar staf (identity user-{id}). */
export async function handleTrackPublished(event: Record<string, unknown>) {
    const room = field(event.room as Record<string, unknown>, 'name')
    const identity = field(event.participant as Record<string, unknown>, 'identity')
    const track = event.track as Record<string, unknown> | undefined
    const organizationId = /^site-(\d+)$/.exec(String(room ?? ''))?.[1]
    const userId = /^user-(\d+)$/.exec(String(identity ?? ''))?.[1]
    const trackSid = String(field(track, 'sid') ?? '')
    const source = String(field(track, 'source') ?? '').toLowerCase() as RecordingSource
    if (!organizationId || !userId || !trackSid || !RECORDING_SOURCES.includes(source)) return

    const already = await db
        .from('live_recordings')
        .where('track_sid', trackSid)
        .whereIn('status', ['recording', 'rotating'])
        .first()
    if (already) return

    await startTrackRecording({
        organizationId: Number(organizationId),
        userId: Number(userId),
        source,
        trackSid,
    })
}

/** Webhook egress_ended: catat hasil; lanjutkan rekaman kalau ini pergantian jam. */
export async function handleEgressEnded(event: Record<string, unknown>) {
    const info = (event.egressInfo ?? event.egress_info) as Record<string, unknown> | undefined
    const egressId = String(field(info, 'egressId', 'egress_id') ?? '')
    if (!egressId) return

    const recording = await db.from('live_recordings').where('egress_id', egressId).first()
    if (!recording) return

    const results =
        (field(info, 'fileResults', 'file_results') as Record<string, unknown>[] | undefined) ?? []
    const file = results[0] ?? (field(info, 'file') as Record<string, unknown> | undefined)
    const size = Number(field(file, 'size') ?? 0)
    const errorText = String(field(info, 'error') ?? '')
    const failed =
        String(field(info, 'status') ?? '').includes('FAILED') || (!size && errorText !== '')

    await db
        .from('live_recordings')
        .where('id', recording.id)
        .update({
            status: failed ? 'failed' : 'completed',
            file_path: String(field(file, 'filename') ?? recording.file_path),
            size_bytes: size || null,
            error: errorText || null,
            ended_at: new Date(),
            updated_at: new Date(),
        })

    if (recording.status === 'rotating') {
        await startTrackRecording({
            organizationId: recording.organization_id,
            userId: recording.user_id,
            source: recording.source,
            trackSid: recording.track_sid,
        })
    }
}

/** Potong rekaman per jam: hentikan yang sudah >= RECORDING_SEGMENT_MINUTES (dilanjutkan di egress_ended). */
export async function rotateRecordings(now: Date = new Date()): Promise<number> {
    if (!recordingEnabled()) return 0
    const cutoff = new Date(now.getTime() - RECORDING_SEGMENT_MINUTES * 60_000)
    const due = await db
        .from('live_recordings')
        .where('status', 'recording')
        .where('started_at', '<=', cutoff)
    for (const recording of due) {
        await db
            .from('live_recordings')
            .where('id', recording.id)
            .update({ status: 'rotating', updated_at: now })
        await stopEgress(recording.egress_id)
    }
    return due.length
}

/** Hapus file & baris rekaman yang lebih tua dari masa simpan (72 jam). */
export async function pruneRecordings(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RECORDING_RETENTION_HOURS * 3_600_000)
    const old = await db.from('live_recordings').where('started_at', '<', cutoff).limit(500)
    for (const recording of old) {
        if (recording.file_path && recordingEnabled()) {
            try {
                await disk('spaces').delete(recording.file_path)
            } catch (error) {
                log.warn({ err: error, id: recording.id }, 'Gagal menghapus file rekaman lama')
                continue
            }
        }
        await db.from('live_recordings').where('id', recording.id).delete()
    }
    return old.length
}

/**
 * Verifikasi webhook LiveKit: header Authorization = JWT HS256 dengan
 * API secret yang sama, dan klaim sha256 = base64(sha256(body mentah)).
 */
export function verifyWebhook(rawBody: string, authorization: string | undefined): boolean {
    const config = liveKitConfig()
    const token = (authorization ?? '').replace(/^Bearer\s+/i, '')
    const [header, payload, signature] = token.split('.')
    if (!header || !payload || !signature || !config.apiSecret) return false

    const expected = createHmac('sha256', config.apiSecret).update(`${header}.${payload}`).digest()
    const given = Buffer.from(signature, 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false

    let claims: Record<string, unknown>
    try {
        claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
        return false
    }
    const now = Math.floor(Date.now() / 1000)
    if (claims.iss !== config.apiKey) return false
    if (typeof claims.exp === 'number' && claims.exp < now - 60) return false
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return false

    const bodyHash = createHash('sha256').update(rawBody, 'utf8').digest('base64')
    return claims.sha256 === bodyHash
}
