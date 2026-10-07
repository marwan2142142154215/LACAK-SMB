import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class ConsentDocument extends BaseModel {
  static table = 'consent_documents'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare organizationId: number

  @column.dateTime()
  declare validUntil: DateTime | null

  @column.dateTime()
  declare revokedAt: DateTime | null

  isActive(): boolean {
    if (this.revokedAt !== null) return false
    if (this.validUntil !== null && this.validUntil < DateTime.now()) return false

    return true
  }
}
