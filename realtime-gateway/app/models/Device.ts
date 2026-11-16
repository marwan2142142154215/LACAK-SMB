import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Model ini membaca/menulis tabel `devices` milik backend-api (Laravel).
 * Gateway TIDAK membuat migration sendiri untuk tabel ini — skema dikelola
 * satu tempat saja di backend-api (lihat docs/skema-database.md) agar tidak
 * ada dua sumber kebenaran struktur data.
 */
export default class Device extends BaseModel {
    static table = 'devices'

    @column({ isPrimary: true })
    declare id: number

    @column()
    declare organizationId: number

    @column()
    declare consentDocumentId: number | null

    @column()
    declare deviceName: string

    @column()
    declare deviceUuid: string

    // Jangan pernah ikut terserialisasi ke payload socket/HTTP mana pun.
    @column({ serializeAs: null })
    declare secretHash: string | null

    @column()
    declare androidVersion: string

    @column()
    declare appBuildVersion: string

    @column()
    declare siteCodeEmbedded: string

    @column()
    declare status: 'online' | 'offline' | 'locked' | 'pending_enrollment'

    @column()
    declare batteryLevel: number | null

    @column()
    declare lastSsid: string | null

    @column.dateTime()
    declare lastSeenAt: DateTime | null

    // --- Detail perangkat dari event device:info (lihat DeviceTelemetry.sanitizeDeviceInfo) ---

    @column()
    declare manufacturer: string | null

    @column()
    declare model: string | null

    @column()
    declare appVersionCode: number | null

    @column()
    declare isCharging: boolean | null

    @column()
    declare networkType: string | null

    @column()
    declare carrierName: string | null

    @column()
    declare storageFreeMb: number | null

    @column()
    declare storageTotalMb: number | null

    // jsonb: node-postgres mengembalikan objek; ditulis sebagai string JSON.
    @column({ prepare: (value: unknown) => (value === null ? null : JSON.stringify(value)) })
    declare permissionState: Record<string, boolean> | null

    @column.dateTime()
    declare infoUpdatedAt: DateTime | null

    // --- Kebijakan kunci HP aset perusahaan + pelepasan (migrasi 0019, dilaporkan APK) ---

    @column()
    declare locationPolicyLocked: boolean | null

    @column()
    declare uninstallLocked: boolean | null

    @column()
    declare locationServiceOn: boolean | null

    @column.dateTime()
    declare releasedAt: DateTime | null

    @column()
    declare isActive: boolean

    @column.dateTime({ autoCreate: false, autoUpdate: true })
    declare updatedAt: DateTime
}
