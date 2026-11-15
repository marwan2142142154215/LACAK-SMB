import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class DeviceLocation extends BaseModel {
    static table = 'device_locations'

    @column({ isPrimary: true })
    declare id: number

    @column()
    declare deviceId: number

    @column()
    declare source: 'ble' | 'gps' | 'ble_estimated'

    @column()
    declare latitude: number | null

    @column()
    declare longitude: number | null

    @column()
    declare bleDistanceMeters: number | null

    @column()
    declare bleRssi: number | null

    /** Radius akurasi fix (meter) menurut Android; null = tidak diketahui. */
    @column()
    declare accuracyMeters: number | null

    /** Sumber fix: gps / network / fused / passive. */
    @column()
    declare locationProvider: string | null

    /** Waktu fix diambil di HP (bisa lebih tua dari recordedAt kalau belum ada fix baru). */
    @column.dateTime()
    declare fixedAt: DateTime | null

    @column.dateTime()
    declare recordedAt: DateTime

    @column.dateTime({ autoCreate: true, autoUpdate: false })
    declare createdAt: DateTime

    @column.dateTime({ autoCreate: true, autoUpdate: true })
    declare updatedAt: DateTime
}
