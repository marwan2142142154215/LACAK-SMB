import { createHash, randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

/**
 * Data uji modul aturan, dibuat langsung di tabel milik backend-api (padanan
 * factory + RolesAndPermissionsSeeder di tes Pest). Peran/izin dibuat kalau
 * belum ada, karena database tes bisa belum di-seed.
 */
const suffix = () => randomBytes(4).toString('hex')

export async function makeOrganization(): Promise<number> {
    const [row] = await db
        .table('organizations')
        .insert({
            name: `Site Uji ${suffix()}`,
            unique_site_code: `UJI-${suffix()}`,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return row.id
}

export async function makeUser(organizationId: number | null, role?: string): Promise<number> {
    const tag = suffix()
    const [row] = await db
        .table('users')
        .insert({
            username: `uji.aturan.${tag}`,
            name: `Uji Aturan ${tag}`,
            email: `uji.aturan.${tag}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            organization_id: organizationId,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    if (role) await assignRole(row.id, role)
    return row.id
}

/** Izin minimal per peran yang dipakai tes ini (subset RolesAndPermissionsSeeder). */
const ROLE_PERMISSIONS: Record<string, string[]> = {
    super_admin: ['geofence-rules.manage', 'consent-documents.manage', 'telegram.manage'],
    site_admin: [
        'geofence-rules.manage',
        'consent-documents.manage',
        'telegram.manage',
        'devices.lock',
    ],
    staff_viewer: [],
    telegram_bot_service: [],
}

async function findOrCreate(table: 'roles' | 'permissions', name: string): Promise<number> {
    const existing = await db.from(table).where('name', name).where('guard_name', 'web').first()
    if (existing) return existing.id
    const [row] = await db
        .table(table)
        .insert({ name, guard_name: 'web', created_at: new Date(), updated_at: new Date() })
        .returning(['id'])
    return row.id
}

export async function assignRole(userId: number, role: string) {
    const roleId = await findOrCreate('roles', role)
    for (const permission of ROLE_PERMISSIONS[role] ?? []) {
        const permissionId = await findOrCreate('permissions', permission)
        await db
            .table('role_has_permissions')
            .insert({ role_id: roleId, permission_id: permissionId })
            .onConflict(['permission_id', 'role_id'])
            .ignore()
    }
    await db
        .table('model_has_roles')
        .insert({ role_id: roleId, model_type: LARAVEL_USER_MORPH, model_id: userId })
}

/** Token Sanctum "id|plain" seperti yang dibuat backend-api. */
export async function bearerFor(userId: number): Promise<string> {
    const plain = randomBytes(20).toString('hex')
    const [row] = await db
        .table('personal_access_tokens')
        .insert({
            tokenable_type: LARAVEL_USER_MORPH,
            tokenable_id: userId,
            name: `web_dashboard-${Date.now()}`,
            device_type: 'computer',
            token: createHash('sha256').update(plain).digest('hex'),
            abilities: '["*"]',
            expires_at: new Date(Date.now() + 2 * 3600_000),
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return `${row.id}|${plain}`
}

export async function makeConsentDocument(organizationId: number, createdBy: number) {
    const [row] = await db
        .table('consent_documents')
        .insert({
            organization_id: organizationId,
            subject_name: 'Subjek Uji',
            signer_name: 'Penanda Tangan',
            signer_role: 'hrd',
            document_file_path: `consent-documents/${organizationId}/tidak-ada-${suffix()}.pdf`,
            signed_at: '2026-10-01',
            created_by: createdBy,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return row.id as number
}

export async function makeDevice(organizationId: number, createdBy: number): Promise<number> {
    const consentDocumentId = await makeConsentDocument(organizationId, createdBy)
    const [row] = await db
        .table('devices')
        .insert({
            organization_id: organizationId,
            consent_document_id: consentDocumentId,
            device_name: `Device ${suffix()}`,
            device_uuid: `uuid-${suffix()}-${suffix()}`,
            android_version: '14',
            app_build_version: '1.0.0',
            site_code_embedded: `SITE-${suffix()}`,
            status: 'online',
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return row.id
}
