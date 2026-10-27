import db from '@adonisjs/lucid/services/db'
import type { Access } from '#services/access'
import { BRIEFING_AUDIENCE_ROLES, sitesOf } from '#services/briefing'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

export type Colleague = { id: number; name: string; role: string | null; site: string | null }

/**
 * Orang yang bisa dipilih user ini (peserta briefing, anggota grup chat):
 * user aktif di site yang dipegangnya -- staf & admin site di site itu, plus
 * leader/admin yang diberi akses ke site itu. Root: semua user.
 */
export async function colleaguesOf(access: Access): Promise<Colleague[]> {
    const own = sitesOf(access)
    const query = db
        .from('users')
        .leftJoin('organizations', 'organizations.id', 'users.organization_id')
        .whereNull('users.deleted_at')
        .where('users.is_active', true)
        .whereNot('users.id', access.userId)
        .orderBy('users.name')
        .select(
            'users.id',
            'users.name',
            'users.organization_id',
            'organizations.name as site_name'
        )
    if (own !== 'all') {
        query.where((scope) => {
            scope
                .whereIn('users.organization_id', own)
                .orWhereIn(
                    'users.id',
                    db.from('user_site_access').whereIn('organization_id', own).select('user_id')
                )
        })
    }
    const rows = await query
    const roles = await db
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .whereIn(
            'model_has_roles.model_id',
            rows.map((row) => row.id)
        )
        .select('model_has_roles.model_id', 'roles.name')
    const roleOf = new Map<number, string>()
    for (const row of roles) {
        const label = BRIEFING_AUDIENCE_ROLES[row.name as keyof typeof BRIEFING_AUDIENCE_ROLES]
        if (label && !roleOf.has(Number(row.model_id))) roleOf.set(Number(row.model_id), label)
    }
    return rows.map((row) => ({
        id: Number(row.id),
        name: row.name as string,
        role: roleOf.get(Number(row.id)) ?? null,
        site: (row.site_name as string | null) ?? null,
    }))
}
