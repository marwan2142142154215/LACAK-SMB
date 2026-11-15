import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { CommandStatus } from '#services/CommandLifecycle'

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
    declare status: CommandStatus

    @column()
    declare reasonNote: string | null

    @column.dateTime()
    declare acknowledgedAt: DateTime | null

    /** Terakhir kali dipancarkan ke socket HP (dikirim ulang selama belum dikonfirmasi). */
    @column.dateTime()
    declare deliveredAt: DateTime | null

    /** Dilaporkan HP selesai dijalankan / gagal (lihat CommandLifecycle). */
    @column.dateTime()
    declare executedAt: DateTime | null

    @column()
    declare resultMessage: string | null

    @column()
    declare deliveryAttempts: number

    @column.dateTime({ autoCreate: true, autoUpdate: false })
    declare createdAt: DateTime

    @column.dateTime({ autoCreate: true, autoUpdate: true })
    declare updatedAt: DateTime
}
