import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class DeviceCommand extends BaseModel {
  static table = 'device_commands'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare deviceId: number

  @column()
  declare commandType: 'lock' | 'unlock' | 'start_monitor' | 'stop_monitor' | 'locate_now'

  @column()
  declare issuedBy: number

  @column()
  declare issuedVia: 'web_dashboard' | 'master_app' | 'telegram_bot' | 'system_auto'

  @column()
  declare status: 'pending' | 'delivered' | 'acknowledged' | 'failed'

  @column()
  declare reasonNote: string | null

  @column.dateTime()
  declare acknowledgedAt: DateTime | null

  @column.dateTime({ autoCreate: true, autoUpdate: false })
  declare createdAt: DateTime
}
