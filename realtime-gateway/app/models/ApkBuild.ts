import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class ApkBuild extends BaseModel {
    static table = 'apk_builds'

    @column({ isPrimary: true })
    declare id: number

    @column()
    declare organizationId: number

    @column()
    declare version: string

    @column()
    declare embeddedSiteCode: string

    @column()
    declare checksumSha256: string

    @column.dateTime({ autoCreate: true, autoUpdate: true })
    declare updatedAt: DateTime
}
