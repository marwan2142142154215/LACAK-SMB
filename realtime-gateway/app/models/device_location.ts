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

  @column.dateTime()
  declare recordedAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: false })
  declare createdAt: DateTime
}
