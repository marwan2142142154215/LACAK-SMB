import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class Organization extends BaseModel {
  static table = 'organizations'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare type: 'company_asset' | 'family_parental'

  @column()
  declare uniqueSiteCode: string

  @column()
  declare isActive: boolean
}
