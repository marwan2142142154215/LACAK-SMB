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
  declare consentDocumentId: number

  @column()
  declare deviceName: string

  @column()
  declare deviceUuid: string

  // Nullable -- device yang belum pernah di-pairing ulang lewat alur
  // device-otp/pair (lihat socket.ts device:hello) belum punya ini.
  @column()
  declare deviceSecret: string | null

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

  @column.dateTime()
  declare lastSeenAt: DateTime | null

  @column()
  declare isActive: boolean

  @column.dateTime({ autoCreate: false, autoUpdate: true })
  declare updatedAt: DateTime
}
