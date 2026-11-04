import db from '@adonisjs/lucid/services/db'
import log from '@adonisjs/core/services/logger'
import { listRoomTracks, roomName, roomOfSession, type RoomTrack } from '#services/Livekit'
import {
    activeRecordingSources,
    RECORDING_MAX_SESSION_HOURS,
    recordingEnabled,
    startTrackRecording,
    type RecordingSource,
} from '#services/Recording'
import { openSessions } from '#services/WorkPresence'

/**
 * Jaring pengaman rekaman: tiap beberapa menit, cocokkan track yang SEDANG tersiar di LiveKit dengan
 * rekaman yang berjalan, lalu mulai ulang yang hilang. Menutup semua penyebab rekaman berhenti di tengah
 * hari (webhook terlewat, rekorder restart/terputus, potongan jam gagal) tanpa menunggu staf menyiar ulang.
 */

/** Rekaman yang macet di 'rotating' (tidak ada laporan selesai) lebih lama dari ini dianggap gagal. */
const STUCK_ROTATING_MINUTES = 5
/** Jeda minimal antar pemeriksaan. */
const RUN_EVERY_MS = 2 * 60_000
/** Batas mulai ulang per putaran supaya rekorder tidak kebanjiran. */
const MAX_STARTS_PER_RUN = 15
/** Berapa room dicek bersamaan. */
const ROOM_CONCURRENCY = 5
/** Jeda sebelum mencoba lagi track yang gagal dimulai (bertambah tiap gagal). */
const RETRY_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000]

const NUMERIC_SOURCES: Record<number, RecordingSource> = { 1: 'camera', 3: 'screen_share' }

/** Sumber track dari LiveKit (nama "CAMERA" atau angka enum) -> sumber rekaman; null = bukan video yang direkam. */
export function recordingSourceOf(raw: unknown): RecordingSource | null {
    if (typeof raw === 'number') return NUMERIC_SOURCES[raw] ?? null
    const name = String(raw ?? '').toLowerCase()
    return name === 'camera' || name === 'screen_share' ? name : null
}

/** Track milik staf ini yang harus direkam tapi belum ada rekaman berjalannya. */
export function tracksToStart(
    userId: number,
    tracks: RoomTrack[],
    recordingSids: Set<string>,
    wanted: RecordingSource[]
): Array<{ sid: string; source: RecordingSource }> {
    const found: Array<{ sid: string; source: RecordingSource }> = []
    for (const track of tracks) {
        if (track.identity !== `user-${userId}` || !track.sid || recordingSids.has(track.sid))
            continue
        const source = recordingSourceOf(track.source)
        if (source && wanted.includes(source)) found.push({ sid: track.sid, source })
    }
    return found
}

/** Jeda tunggu sebelum percobaan ke-(attempts+1); naik bertahap sampai batas. */
export const backoffMs = (attempts: number) =>
    RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1] ?? 0

const retries = new Map<string, { attempts: number; notBefore: number }>()
let lastRun = 0

export async function reconcileRecordings(now: Date = new Date()): Promise<number> {
    if (!recordingEnabled() || now.getTime() - lastRun < RUN_EVERY_MS) return 0
    lastRun = now.getTime()

    await db
        .from('live_recordings')
        .where('status', 'rotating')
        .where('updated_at', '<', new Date(now.getTime() - STUCK_ROTATING_MINUTES * 60_000))
        .update({
            status: 'failed',
            error: 'Macet saat pergantian jam (tidak ada laporan selesai)',
            ended_at: now,
            updated_at: now,
        })

    const since = new Date(now.getTime() - RECORDING_MAX_SESSION_HOURS * 3_600_000)
    const openRows = await openSessions().where('work_sessions.started_at', '>', since)
    const sessions = openRows.filter((session) => session.organization_id)
    const byRoom = new Map<string, typeof sessions>()
    for (const session of sessions) {
        const room = roomName(roomOfSession(session))
        byRoom.set(room, [...(byRoom.get(room) ?? []), session])
    }

    const wanted = activeRecordingSources()
    const rooms = [...byRoom.entries()]
    let started = 0
    for (let index = 0; index < rooms.length; index += ROOM_CONCURRENCY) {
        const batch = rooms.slice(index, index + ROOM_CONCURRENCY)
        const listed = await Promise.all(
            batch.map(([, roomSessions]) => listRoomTracks(roomOfSession(roomSessions[0])))
        )
        for (const [position, tracks] of listed.entries()) {
            if (!tracks) continue
            for (const session of batch[position][1]) {
                if (started >= MAX_STARTS_PER_RUN) return started
                started += await resume(session, tracks, wanted, now)
            }
        }
    }

    for (const [sid, state] of retries)
        if (state.notBefore < now.getTime() - 3_600_000) retries.delete(sid)
    return started
}

async function resume(
    session: Record<string, any>,
    tracks: RoomTrack[],
    wanted: RecordingSource[],
    now: Date
): Promise<number> {
    const mine = tracks.filter((track) => track.identity === `user-${session.user_id}`)
    if (mine.length === 0) return 0

    const running = await db
        .from('live_recordings')
        .whereIn(
            'track_sid',
            mine.map((track) => track.sid)
        )
        .whereIn('status', ['recording', 'rotating'])
        .select('track_sid')
    const recordingSids = new Set(running.map((row) => String(row.track_sid)))

    let started = 0
    for (const { sid, source } of tracksToStart(session.user_id, mine, recordingSids, wanted)) {
        const state = retries.get(sid)
        if (state && state.notBefore > now.getTime()) continue

        const egressId = await startTrackRecording({
            organizationId: Number(session.organization_id),
            userId: Number(session.user_id),
            source,
            trackSid: sid,
        })
        if (egressId) {
            retries.delete(sid)
            started++
            log.info({ userId: session.user_id, source, sid }, 'Rekaman dilanjutkan oleh pemeriksa')
        } else {
            const attempts = (state?.attempts ?? 0) + 1
            retries.set(sid, { attempts, notBefore: now.getTime() + backoffMs(attempts) })
        }
    }
    return started
}
