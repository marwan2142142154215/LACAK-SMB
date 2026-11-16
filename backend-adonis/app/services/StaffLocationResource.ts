import db from '@adonisjs/lucid/services/db'
import { laravelDate } from '#services/ActivityLog'
import { laravelDecimal } from '#services/DeviceResource'

/**
 * Bentuk data & helper baca lokasi staf (ditulis gateway ke `staff_locations`).
 * Dibaca pengawas (radar.view) untuk peta Radar & detail staf.
 */
export type StaffLocationRow = {
    id: number
    user_id: number
    organization_id: number | null
    latitude: string | number | null
    longitude: string | number | null
    accuracy_meters: string | number | null
    source: string
    confidence: string
    is_mock: boolean
    client: string
    captured_at: Date | null
}

export function staffLocationResource(row: StaffLocationRow) {
    return {
        id: row.id,
        user_id: row.user_id,
        organization_id: row.organization_id ?? null,
        latitude: laravelDecimal(row.latitude, 7),
        longitude: laravelDecimal(row.longitude, 7),
        accuracy_meters: laravelDecimal(row.accuracy_meters ?? null, 2),
        source: row.source,
        confidence: row.confidence,
        is_mock: Boolean(row.is_mock),
        client: row.client,
        captured_at: laravelDate(row.captured_at ?? null),
    }
}

/** Lokasi terakhir per staf (distinctOn user_id, captured_at desc). */
export async function latestStaffLocationsOf(userIds: number[]) {
    const latest = new Map<number, StaffLocationRow>()
    if (!userIds.length) return latest

    const rows = await db
        .from('staff_locations')
        .distinctOn('user_id')
        .whereIn('user_id', userIds)
        .orderBy('user_id')
        .orderBy('captured_at', 'desc')
        .select('*')
    for (const row of rows) latest.set(Number(row.user_id), row as StaffLocationRow)
    return latest
}
