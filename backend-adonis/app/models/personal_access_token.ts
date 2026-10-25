import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Token Sanctum (tabel personal_access_tokens). Token login punya expires_at
 * (idle timeout 2 jam, digeser tiap request); token akun layanan tidak.
 * Lihat app/middleware/auth_middleware.ts.
 */
export default class PersonalAccessToken extends BaseModel {
    static table = 'personal_access_tokens'

    @column({ isPrimary: true })
    declare id: number

    @column()
    declare tokenableType: string

    @column()
    declare tokenableId: number

    @column()
    declare name: string

    /** 'computer' | 'phone' | null -- perangkat tempat login. */
    @column()
    declare deviceType: string | null

    @column({ serializeAs: null })
    declare token: string

    @column()
    declare abilities: string | null

    @column.dateTime()
    declare lastUsedAt: DateTime | null

    @column.dateTime()
    declare expiresAt: DateTime | null

    @column.dateTime({ autoCreate: true })
    declare createdAt: DateTime

    @column.dateTime({ autoCreate: true, autoUpdate: true })
    declare updatedAt: DateTime

    get isExpired(): boolean {
        return this.expiresAt !== null && this.expiresAt <= DateTime.now()
    }
}
