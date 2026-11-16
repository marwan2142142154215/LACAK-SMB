import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Lokasi staf dari agen native (APK HP / aplikasi desktop PC) selama login.
 * Ditulis oleh gateway lewat handler socket `staff:location` (StaffLocationHub),
 * dibaca backend-adonis lewat raw query (StaffLocationResource). Append-only.
 */
export default class StaffLocation extends BaseModel {
    static table = 'staff_locations'

    @column({ isPrimary: true })
    declare id: number

    @column()
    declare userId: number

    @column()
    declare organizationId: number | null

    @column()
    declare latitude: number | null

    @column()
    declare longitude: number | null

    @column()
    declare accuracyMeters: number | null

    @column()
    declare source: 'gps' | 'wifi' | 'network' | 'ip'

    @column()
    declare confidence: 'high' | 'low'

    @column()
    declare isMock: boolean

    @column()
    declare client: 'android' | 'desktop' | 'web'

    @column.dateTime()
    declare capturedAt: DateTime

    @column.dateTime({ autoCreate: true, autoUpdate: false })
    declare createdAt: DateTime
}
