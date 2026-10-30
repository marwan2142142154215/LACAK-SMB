import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { laravelDate, logModelEvent } from '#services/activity_log'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

/*
|--------------------------------------------------------------------------
| Bentuk data staf & site -- padanan UserResource & OrganizationResource
|--------------------------------------------------------------------------
*/

/** Morph Laravel untuk subject activity_log site. */
export const ORGANIZATION_MORPH = 'App\\Models\\Organization'

/** Kolom users yang dibaca modul staf. */
export type UserRow = {
    id: number
    name: string
    username: string
    email: string | null
    organization_id: number | null
    is_active: boolean
    created_at: Date | null
}

export type OrganizationRow = {
    id: number
    name: string
    type: string
    unique_site_code: string
    is_active: boolean
    created_at: Date | null
    updated_at: Date | null
    devices_count?: number
}

export const USER_COLUMNS = [
    'id',
    'name',
    'username',
    'email',
    'organization_id',
    'is_active',
    'created_at',
]

/**
 * Parameter route {user}/{organization} -> id. Laravel membiarkan nilai
 * bukan angka jatuh ke query (Postgres menolaknya jadi 500); di sini
 * langsung dianggap tidak ditemukan.
 */
export function routeId(value: unknown): number | null {
    return typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : null
}

export function usersQuery() {
    return db.from('users').whereNull('users.deleted_at')
}

/** Route model binding User: staf yang di-soft-delete dianggap tidak ada (404). */
export async function findUser(id: number | null): Promise<UserRow | null> {
    if (id === null) return null
    return (await usersQuery().where('id', id).select(USER_COLUMNS).first()) ?? null
}

/**
 * UserResource untuk banyak staf sekaligus: role = peran pertama,
 * site_access = site yang diberikan (site yang sudah di-soft-delete tidak
 * ikut, sama seperti relasi siteAccess Eloquent).
 */
export async function userResources(users: UserRow[]) {
    const ids = users.map((user) => user.id)
    const [roleRows, siteRows] = ids.length
        ? await Promise.all([
              db
                  .from('model_has_roles')
                  .join('roles', 'roles.id', 'model_has_roles.role_id')
                  .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
                  .whereIn('model_has_roles.model_id', ids)
                  .orderBy('roles.id')
                  .select('model_has_roles.model_id as user_id', 'roles.name'),
              db
                  .from('user_site_access')
                  .join('organizations', 'organizations.id', 'user_site_access.organization_id')
                  .whereNull('organizations.deleted_at')
                  .whereIn('user_site_access.user_id', ids)
                  .orderBy('user_site_access.id')
                  .select('user_site_access.user_id', 'organizations.id', 'organizations.name'),
          ])
        : [[], []]

    const roleOf = new Map<number, string>()
    for (const row of roleRows) {
        if (!roleOf.has(Number(row.user_id))) roleOf.set(Number(row.user_id), row.name)
    }
    const sitesOf = new Map<number, Array<{ id: number; name: string }>>()
    for (const row of siteRows) {
        const list = sitesOf.get(Number(row.user_id)) ?? []
        list.push({ id: Number(row.id), name: row.name })
        sitesOf.set(Number(row.user_id), list)
    }

    return users.map((user) => ({
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        organization_id: user.organization_id,
        role: roleOf.get(user.id) ?? null,
        site_access: sitesOf.get(user.id) ?? [],
        is_active: user.is_active,
        created_at: laravelDate(user.created_at),
    }))
}

export async function userResource(user: UserRow) {
    const [resource] = await userResources([user])
    return resource
}

/** UserResource dari data terbaru di database ($user->fresh([...])). */
export async function freshUserResource(id: number) {
    const user = await db.from('users').where('id', id).select(USER_COLUMNS).firstOrFail()
    return userResource(user)
}

/** OrganizationResource: devices_count hanya ada kalau dihitung (whenCounted). */
export function organizationResource(organization: OrganizationRow) {
    return {
        id: organization.id,
        name: organization.name,
        type: organization.type,
        unique_site_code: organization.unique_site_code,
        is_active: organization.is_active,
        ...(organization.devices_count !== undefined
            ? { devices_count: Number(organization.devices_count) }
            : {}),
        created_at: laravelDate(organization.created_at),
        updated_at: laravelDate(organization.updated_at),
    }
}

/*
|--------------------------------------------------------------------------
| Activity log (LogsActivity) untuk User & Organization
|--------------------------------------------------------------------------
*/

/** User::getActivitylogOptions(): logOnly username, email, is_active. */
export const USER_LOGGED_FIELDS = ['username', 'email', 'is_active'] as const

/** Organization::getActivitylogOptions(). */
export const ORGANIZATION_LOGGED_FIELDS = ['name', 'type', 'unique_site_code', 'is_active'] as const

/**
 * logOnlyDirty: hanya field tercatat yang benar-benar berubah, beserta
 * nilai lamanya. null = tidak ada perubahan -> dontSubmitEmptyLogs.
 */
export function dirtyLogged(
    fields: readonly string[],
    before: Record<string, unknown>,
    after: Record<string, unknown>
): { attributes: Record<string, unknown>; old: Record<string, unknown> } | null {
    const attributes: Record<string, unknown> = {}
    const old: Record<string, unknown> = {}
    for (const field of fields) {
        if (field in after && after[field] !== before[field]) {
            attributes[field] = after[field]
            old[field] = before[field] ?? null
        }
    }
    return Object.keys(attributes).length ? { attributes, old } : null
}

export function pickLogged(fields: readonly string[], row: Record<string, unknown>) {
    return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]))
}

/**
 * Site catatan log untuk subject User: site staf itu, kalau kosong site
 * pelakunya (AppServiceProvider::boot di backend-api).
 */
export function userLogOrganizationId(ctx: HttpContext, user: { organization_id: number | null }) {
    return user.organization_id ?? ctx.authUser?.organizationId ?? null
}

/** Catat created/deleted User dengan atribut dari database (fresh()). */
export async function logUserSnapshot(
    ctx: HttpContext,
    event: 'created' | 'deleted',
    userId: number
) {
    const row = await db
        .from('users')
        .where('id', userId)
        .select('username', 'email', 'is_active', 'organization_id')
        .first()
    if (!row) return
    await logModelEvent(ctx, {
        event,
        subjectType: LARAVEL_USER_MORPH,
        subjectId: userId,
        organizationId: userLogOrganizationId(ctx, row),
        attributes: pickLogged(USER_LOGGED_FIELDS, row),
    })
}

export async function logUserChanges(
    ctx: HttpContext,
    before: UserRow,
    after: Record<string, unknown>,
    organizationId: number | null
) {
    const changes = dirtyLogged(USER_LOGGED_FIELDS, before, after)
    if (!changes) return
    await logModelEvent(ctx, {
        event: 'updated',
        subjectType: LARAVEL_USER_MORPH,
        subjectId: before.id,
        organizationId: organizationId ?? ctx.authUser?.organizationId ?? null,
        attributes: changes.attributes,
        old: changes.old,
    })
}
