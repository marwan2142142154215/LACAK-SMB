import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class GeofenceRule extends BaseModel {
  static table = 'geofence_rules'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare organizationId: number

  @column()
  declare ruleName: string

  @column()
  declare allowedSsid: string | null

  @column()
  declare allowedIpCidr: string | null

  @column()
  declare maxDistanceMeters: number | null

  @column()
  declare centerLatitude: number | null

  @column()
  declare centerLongitude: number | null

  @column()
  declare isActive: boolean
}
