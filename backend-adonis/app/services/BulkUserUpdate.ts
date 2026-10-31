import {
    BULK_MODES,
    MAX_BULK_USERS,
    parseBulkSiteAccess,
    type BulkMode,
} from '#services/BulkSiteAccess'
import { ROLE_NAME_PATTERN } from '#services/RoleRules'

/**
 * Update massal staf (menu Staf > Update): pilih banyak staf lalu ubah peran, status
 * (aktifkan / suspen), dan/atau akses site sekaligus. Semua perubahan satu transaksi;
 * staf yang tidak boleh diubah dilewati dan dilaporkan, bukan membatalkan yang lain.
 * Bagian ini murni (validasi input); UsersController.bulkUpdate yang menulis database.
 */
export const BULK_STATUSES = ['active', 'suspended'] as const
export type BulkStatus = (typeof BULK_STATUSES)[number]

export type BulkUserUpdateInput = {
    userIds: number[]
    /** Nama peran yang dipasang (menggantikan peran lama), atau null = peran tidak diubah. */
    role: string | null
    status: BulkStatus | null
    /** null = akses site tidak diubah. */
    sites: { mode: BulkMode; organizationIds: number[] | 'all' } | null
}

type Parsed =
    { ok: true; data: BulkUserUpdateInput } | { ok: false; errors: Record<string, string[]> }

const blank = (value: unknown) => value === undefined || value === null || value === ''

export function parseBulkUserUpdate(input: Record<string, unknown>): Parsed {
    const errors: Record<string, string[]> = {}

    let role: string | null = null
    if (!blank(input.role)) {
        if (typeof input.role === 'string' && ROLE_NAME_PATTERN.test(input.role)) role = input.role
        else errors.role = ['Peran tidak valid.']
    }

    let status: BulkStatus | null = null
    if (!blank(input.status)) {
        if ((BULK_STATUSES as readonly string[]).includes(String(input.status))) {
            status = input.status as BulkStatus
        } else errors.status = ['Status harus active atau suspended.']
    }

    let sites: BulkUserUpdateInput['sites'] = null
    let userIds: number[] = []
    // Daftar staf & pilihan site dicek oleh parser akses site massal (aturan yang sama persis).
    const siteMode = blank(input.site_mode) ? null : String(input.site_mode)
    if (siteMode !== null && !(BULK_MODES as readonly string[]).includes(siteMode)) {
        errors.site_mode = [`Mode site harus salah satu dari: ${BULK_MODES.join(', ')}.`]
    }
    const siteParsed = parseBulkSiteAccess({
        user_ids: input.user_ids,
        mode: siteMode ?? 'add',
        organization_ids: input.organization_ids,
        all_sites: input.all_sites,
    })
    if (siteParsed.ok) {
        userIds = siteParsed.data.userIds
        if (siteMode !== null && !errors.site_mode) {
            sites = {
                mode: siteParsed.data.mode,
                organizationIds: siteParsed.data.organizationIds,
            }
        }
    } else {
        // Kesalahan pilihan site hanya dihitung kalau akses site memang mau diubah.
        for (const [field, messages] of Object.entries(siteParsed.errors)) {
            const siteField = field === 'organization_ids' || field === 'mode'
            if (!siteField || siteMode !== null) errors[field] = messages
        }
        const ids = siteParsed.errors.user_ids ? [] : userIdsOf(input.user_ids)
        userIds = ids
    }

    if (userIds.length > MAX_BULK_USERS) {
        errors.user_ids = [`Paling banyak ${MAX_BULK_USERS} staf sekali proses.`]
    }
    if (role === null && status === null && siteMode === null && !errors.role && !errors.status) {
        errors.changes = ['Pilih minimal satu perubahan: peran, status, atau akses site.']
    }

    if (Object.keys(errors).length > 0) return { ok: false, errors }
    return { ok: true, data: { userIds, role, status, sites } }
}

/** Daftar id dari input mentah (untuk kasus parser site gagal tapi daftar staf valid). */
function userIdsOf(value: unknown): number[] {
    if (!Array.isArray(value)) return []
    const ids = value
        .map((item) => Number(item))
        .filter((id) => Number.isSafeInteger(id) && id >= 1)
    return [...new Set(ids)]
}
