import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class ViolationLog extends BaseModel {
  static table = 'violation_logs'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare deviceId: number

  @column()
  declare geofenceRuleId: number | null

  @column()
  declare violationType: 'wifi_mismatch' | 'ip_mismatch' | 'distance_exceeded'

  @column()
  declare detectedValue: string

  @column()
  declare notifiedTelegram: boolean

  @column()
  declare notifiedDashboard: boolean

  @column.dateTime()
  declare detectedAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: false })
  declare createdAt: DateTime
}
