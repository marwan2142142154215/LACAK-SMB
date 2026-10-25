import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, scope } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import PersonalAccessToken from '#models/personal_access_token'

/**
 * Tabel users milik backend-api (Laravel). Skema masih dikelola migrasi
 * Laravel -- kolom di sini hanya yang dipakai Adonis. User yang di-soft-delete
 * (deleted_at) dianggap tidak ada, sama seperti Eloquent SoftDeletes.
 */
export default class User extends BaseModel {
    static table = 'users'

    @column({ isPrimary: true })
    declare id: number

    @column()
    declare username: string

    @column()
    declare name: string

    @column()
    declare email: string | null

    @column({ serializeAs: null })
    declare password: string

    @column()
    declare organizationId: number | null

    @column()
    declare isActive: boolean

    @column({ serializeAs: null })
    declare twoFactorSecret: string | null

    @column({ serializeAs: null })
    declare twoFactorRecoveryCodes: string | null

    @column.dateTime()
    declare twoFactorConfirmedAt: DateTime | null

    @column.dateTime({ autoCreate: true })
    declare createdAt: DateTime

    @column.dateTime({ autoCreate: true, autoUpdate: true })
    declare updatedAt: DateTime

    @column.dateTime({ serializeAs: null })
    declare deletedAt: DateTime | null

    @hasMany(() => PersonalAccessToken, { foreignKey: 'tokenableId' })
    declare tokens: HasMany<typeof PersonalAccessToken>

    static withoutTrashed = scope((query) => {
        query.whereNull('users.deleted_at')
    })
}
