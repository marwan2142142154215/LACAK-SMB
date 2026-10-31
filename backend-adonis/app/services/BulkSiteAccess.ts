import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import { BUILT_IN_SCOPES, widestScope, type SiteScope } from '#services/RoleRules'

/** Peran bawaan ber-cakupan "granted" (tetap) dan semua nama peran bawaan. */
const GRANT_ROLES = Object.keys(BUILT_IN_SCOPES).filter(
    (name) => BUILT_IN_SCOPES[name] === 'granted'
)
const BUILT_IN_NAMES = Object.keys(BUILT_IN_SCOPES)

/**
 * Atur akses site untuk BANYAK user sekaligus (menu Staf > Atur site massal).
 *
 * - add     : tambahkan site yang dipilih, akses yang sudah ada dibiarkan.
 * - remove  : cabut site yang dipilih (semua akses kalau all_sites).
 * - replace : akses tiap user diganti persis dengan site yang dipilih.
 *
 * Hanya user yang perannya ber-cakupan "granted" (admin, leader, atau peran buatan
 * sendiri yang diatur begitu di menu Peran) yang punya akses per site
 * (user_site_access); user lain dilewati dan dilaporkan, bukan dianggap error.
 * Seluruh perubahan satu transaksi: gagal di tengah = tidak ada yang berubah.
 */
export const BULK_MODES = ['add', 'remove', 'replace'] as const
export type BulkMode = (typeof BULK_MODES)[number]

export const MAX_BULK_USERS = 200
export const MAX_BULK_SITES = 1000
/** Baris pivot per INSERT: aman dari batas parameter PostgreSQL (65535). */
const INSERT_CHUNK = 1000

export type BulkSiteAccessInput = {
    userIds: number[]
    /** Daftar site, atau 'all' = semua site yang belum dihapus saat ini. */
    organizationIds: number[] | 'all'
    mode: BulkMode
}

export type SkippedUser = { id: number; name: string | null; reason: string }

type ParseResult =
    { ok: true; data: BulkSiteAccessInput } | { ok: false; errors: Record<string, string[]> }

/** Bilangan bulat positif dari angka atau teks angka; selain itu null. */
function positiveInteger(value: unknown): number | null {
    const number =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())
              ? Number(value.trim())
              : Number.NaN
    return Number.isSafeInteger(number) && number >= 1 ? number : null
}

function integerList(value: unknown): number[] | null {
    if (!Array.isArray(value)) return null
    const result: number[] = []
    for (const item of value) {
        const number = positiveInteger(item)
        if (number === null) return null
        result.push(number)
    }
    return [...new Set(result)]
}

function truthy(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 'true'
}

/** Validasi input mentah; tanpa akses database. */
export function parseBulkSiteAccess(input: Record<string, unknown>): ParseResult {
    const errors: Record<string, string[]> = {}

    const userIds = integerList(input.user_ids)
    if (userIds === null || userIds.length === 0) {
        errors.user_ids = ['Pilih minimal satu user (daftar angka id).']
    } else if (userIds.length > MAX_BULK_USERS) {
        errors.user_ids = [`Paling banyak ${MAX_BULK_USERS} user sekali proses.`]
    }

    const mode = input.mode === undefined || input.mode === null ? 'add' : String(input.mode)
    if (!(BULK_MODES as readonly string[]).includes(mode)) {
        errors.mode = [`Mode harus salah satu dari: ${BULK_MODES.join(', ')}.`]
    }

    const allSites = truthy(input.all_sites)
    let organizationIds: number[] | 'all' = 'all'
    if (!allSites) {
        const list = integerList(input.organization_ids)
        if (list === null) {
            errors.organization_ids = ['Pilih site (daftar angka id) atau aktifkan semua site.']
        } else if (list.length === 0) {
            errors.organization_ids = ['Pilih minimal satu site atau aktifkan semua site.']
        } else if (list.length > MAX_BULK_SITES) {
            errors.organization_ids = [`Paling banyak ${MAX_BULK_SITES} site sekali proses.`]
        } else {
            organizationIds = list
        }
    }

    if (Object.keys(errors).length > 0 || userIds === null) {
        return { ok: false, errors }
    }
    return { ok: true, data: { userIds, organizationIds, mode: mode as BulkMode } }
}

function chunks<T>(items: T[], size: number): T[][] {
    const result: T[][] = []
    for (let index = 0; index < items.length; index += size) {
        result.push(items.slice(index, index + size))
    }
    return result
}

/** Pisahkan user yang boleh diatur (admin/leader, belum dihapus) dari yang dilewati. */
export async function partitionUsers(
    client: TransactionClientContract,
    userIds: number[]
): Promise<{ eligible: number[]; skipped: SkippedUser[] }> {
    const users = await client
        .from('users')
        .whereIn('id', userIds)
        .whereNull('deleted_at')
        .select('id', 'name')
    const grantHolders = await client
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .whereIn('model_has_roles.model_id', userIds)
        .where((scope) =>
            scope
                .whereIn('roles.name', GRANT_ROLES)
                .orWhere((custom) =>
                    custom
                        .where('roles.site_scope', 'granted')
                        .whereNotIn('roles.name', BUILT_IN_NAMES)
                )
        )
        .select('model_has_roles.model_id')
    const eligibleIds = new Set(grantHolders.map((row) => Number(row.model_id)))
    const foundIds = new Set(users.map((row) => Number(row.id)))

    const skipped: SkippedUser[] = []
    for (const id of userIds) {
        if (!foundIds.has(id)) {
            skipped.push({ id, name: null, reason: 'User tidak ditemukan' })
        } else if (!eligibleIds.has(id)) {
            const name = users.find((row) => Number(row.id) === id)?.name ?? null
            skipped.push({
                id,
                name,
                reason: 'Hanya peran ber-cakupan "site yang diberikan" yang punya akses per site',
            })
        }
    }
    return { eligible: userIds.filter((id) => eligibleIds.has(id)), skipped }
}

/**
 * Cakupan site tiap user (terluas dari semua perannya; peran bawaan memakai cakupan tetapnya).
 * Menentukan cara "mengatur site": 'granted' = daftar akses (user_site_access), 'own' = satu site
 * tempat staf ditempatkan (users.organization_id), 'all' = sudah melihat semua site.
 */
export async function scopesOfUsers(
    client: TransactionClientContract,
    userIds: number[]
): Promise<Map<number, SiteScope>> {
    const rows = await client
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .whereIn('model_has_roles.model_id', userIds)
        .select('model_has_roles.model_id', 'roles.name', 'roles.site_scope')

    const scopes = new Map<number, SiteScope[]>()
    for (const row of rows) {
        const id = Number(row.model_id)
        const list = scopes.get(id) ?? []
        list.push(BUILT_IN_SCOPES[row.name] ?? (row.site_scope as SiteScope))
        scopes.set(id, list)
    }
    return new Map(userIds.map((id) => [id, widestScope(scopes.get(id) ?? [])]))
}

/** Site yang dipilih -> daftar id. 'all' = semua site belum dihapus; daftar = harus ada semua. */
export async function resolveOrganizations(
    client: TransactionClientContract,
    organizationIds: number[] | 'all'
): Promise<{ ids: number[]; missing: number[] }> {
    const query = client.from('organizations').whereNull('deleted_at')
    if (organizationIds !== 'all') query.whereIn('id', organizationIds)
    const rows = await query.select('id')
    const found = rows.map((row) => Number(row.id))

    if (organizationIds === 'all') return { ids: found, missing: [] }
    const foundSet = new Set(found)
    return { ids: found, missing: organizationIds.filter((id) => !foundSet.has(id)) }
}

/** Terapkan perubahan; mengembalikan jumlah pasangan user-site yang kini berlaku. */
export async function applyBulkSiteAccess(
    client: TransactionClientContract,
    params: {
        userIds: number[]
        organizationIds: number[]
        mode: BulkMode
        grantedBy: number
        /** Mode remove + semua site: cabut seluruh akses user, termasuk site yang sudah dihapus. */
        removeEverything?: boolean
    }
): Promise<void> {
    const { userIds, organizationIds, mode, grantedBy } = params
    if (userIds.length === 0) return

    if (mode === 'remove') {
        const query = client.from('user_site_access').whereIn('user_id', userIds)
        if (!params.removeEverything) query.whereIn('organization_id', organizationIds)
        await query.delete()
        return
    }

    if (mode === 'replace') {
        await client
            .from('user_site_access')
            .whereIn('user_id', userIds)
            .whereNotIn('organization_id', organizationIds)
            .delete()
    }

    const now = new Date()
    const pairs = userIds.flatMap((userId) =>
        organizationIds.map((organizationId) => ({
            user_id: userId,
            organization_id: organizationId,
            granted_by: grantedBy,
            created_at: now,
            updated_at: now,
        }))
    )
    for (const part of chunks(pairs, INSERT_CHUNK)) {
        await client
            .table('user_site_access')
            .multiInsert(part)
            .onConflict(['user_id', 'organization_id'])
            .merge(['granted_by', 'updated_at'])
    }
}

/** Ringkasan untuk log aktivitas (tanpa memuat ribuan id). */
export function summarize(input: BulkSiteAccessInput, siteCount: number, userCount: number) {
    return {
        mode: input.mode,
        all_sites: input.organizationIds === 'all',
        site_count: siteCount,
        user_ids: input.userIds.slice(0, MAX_BULK_USERS),
        updated_users: userCount,
    }
}
