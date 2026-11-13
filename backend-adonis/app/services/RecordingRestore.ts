import { createHash } from 'node:crypto'
import { atLocal } from '#services/LocalTime'
import { staffFolderName, type RecordingSource } from '#services/Recording'
import type { SpacesObject } from '#services/Storage'

/**
 * Membuat ulang baris live_recordings dari berkas rekaman yang masih ada di Spaces. Dashboard membaca daftar
 * rekaman dari database, jadi berkas yang barisnya sudah terhapus (mis. masa simpan dipendekkan) tidak terlihat
 * walau masih ada di bucket.
 */

const PATH_PATTERN =
    /^recordings\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/(camera|screen_share)-(\d{2})(\d{2})(\d{2})-(TR_[A-Za-z0-9]+)\.webm$/

export type ParsedRecordingPath = {
    date: string
    folder: string
    source: RecordingSource
    /** Jam lokal (APP_TIMEZONE) mulai rekaman, "HH:mm:ss". */
    time: string
    trackSid: string
}

/** recordings/{tanggal}/{nama staf}/{sumber}-{jam}-{track}.webm -> bagian-bagiannya; null kalau bukan berkas rekaman. */
export function parseRecordingPath(path: string): ParsedRecordingPath | null {
    const match = PATH_PATTERN.exec(path)
    if (!match) return null
    return {
        date: match[1],
        folder: match[2],
        source: match[3] as RecordingSource,
        time: `${match[4]}:${match[5]}:${match[6]}`,
        trackSid: match[7],
    }
}

export type RestoreUser = { id: number; name: string | null; organization_id: number | null }

export type RestoreRow = {
    organization_id: number
    user_id: number
    egress_id: string
    track_sid: string
    source: RecordingSource
    file_path: string
    size_bytes: number
    started_at: Date
    ended_at: Date
}

export type RestorePlan = {
    rows: RestoreRow[]
    skipped: {
        existing: number
        unrecognized: number
        unknownStaff: number
        ambiguousStaff: number
    }
}

/**
 * Rencana pemulihan: tiap berkas yang belum punya baris dicocokkan ke staf lewat nama foldernya. Folder yang
 * cocok dengan lebih dari satu staf (nama kembar) tidak ditebak, hanya dilaporkan.
 */
export function planRestore(
    objects: SpacesObject[],
    users: RestoreUser[],
    existingPaths: Set<string>
): RestorePlan {
    const byFolder = new Map<string, RestoreUser[]>()
    for (const user of users) {
        const folder = staffFolderName(user.name, user.id)
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), user])
    }

    const skipped = { existing: 0, unrecognized: 0, unknownStaff: 0, ambiguousStaff: 0 }
    const rows: RestoreRow[] = []
    for (const object of objects) {
        const parsed = parseRecordingPath(object.path)
        if (!parsed) {
            skipped.unrecognized++
            continue
        }
        if (existingPaths.has(object.path)) {
            skipped.existing++
            continue
        }
        const candidates = byFolder.get(parsed.folder) ?? []
        if (candidates.length > 1) {
            skipped.ambiguousStaff++
            continue
        }
        const user = candidates[0]
        if (!user || user.organization_id === null) {
            skipped.unknownStaff++
            continue
        }

        const startedAt = atLocal(parsed.date, parsed.time)
        const finished = object.lastModified
        rows.push({
            organization_id: user.organization_id,
            user_id: user.id,
            egress_id: `RESTORED_${createHash('sha1').update(object.path).digest('hex').slice(0, 32)}`,
            track_sid: parsed.trackSid,
            source: parsed.source,
            file_path: object.path,
            size_bytes: object.size,
            started_at: startedAt,
            ended_at: finished && finished > startedAt ? finished : startedAt,
        })
    }
    return { rows, skipped }
}
