/**
 * Aturan menu Peran (Akses > Peran): bentuk data peran, peran yang dikunci, dan
 * pencegahan "naik pangkat" lewat pengelolaan peran. Murni (tanpa database) supaya
 * mudah diuji; RolesController yang membaca/menulis tabelnya.
 */

/** Cakupan site sebuah peran: semua site / site yang diberikan (user_site_access) / site sendiri. */
export const SITE_SCOPES = ['all', 'granted', 'own'] as const
export type SiteScope = (typeof SITE_SCOPES)[number]

const SCOPE_RANK: Record<SiteScope, number> = { own: 0, granted: 1, all: 2 }

export const scopeRank = (scope: SiteScope) => SCOPE_RANK[scope]

/** Cakupan yang lebih luas menang kalau satu user punya beberapa peran. */
export const widestScope = (scopes: SiteScope[]): SiteScope =>
    scopes.reduce<SiteScope>(
        (widest, scope) => (SCOPE_RANK[scope] > SCOPE_RANK[widest] ? scope : widest),
        'own'
    )

/**
 * Peran bawaan sistem. Cakupan site-nya TETAP (tidak bisa diubah dari menu Peran):
 * kode lain (mis. ruang leader, pembatasan staf biasa) bergantung pada nama-nama ini.
 */
export const BUILT_IN_SCOPES: Record<string, SiteScope> = {
    super_admin: 'all',
    admin: 'granted',
    leader: 'granted',
    site_admin: 'own',
    staff_viewer: 'own',
    telegram_bot_service: 'own',
}

/**
 * Peran yang tidak boleh diubah / dihapus / diberikan lewat menu Peran:
 * super_admin (satu-satunya pemegang semua izin, anti-terkunci) dan akun layanan bot.
 */
export const LOCKED_ROLES = ['super_admin', 'telegram_bot_service']

/** Izin yang menyangkut pengelolaan akses: hanya bisa diberikan oleh yang memegangnya sendiri. */
export const SENSITIVE_PERMISSIONS = [
    'roles.manage',
    'users.manage',
    'organizations.manage',
    'security.manage',
]

export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]{1,39}$/
export const MAX_LABEL = 100
export const MAX_DESCRIPTION = 255

export type RoleInput = {
    /** Hanya dipakai saat membuat; nama peran tidak bisa diganti setelahnya. */
    name?: string
    label: string
    description: string | null
    siteScope: SiteScope
    permissions: string[]
}

type Parsed = { ok: true; data: RoleInput } | { ok: false; errors: Record<string, string[]> }

const isScope = (value: unknown): value is SiteScope =>
    typeof value === 'string' && (SITE_SCOPES as readonly string[]).includes(value)

/**
 * Validasi isian peran. `creating` = nama wajib (huruf kecil, angka, garis bawah).
 * Daftar izin diambil apa adanya (unik); keberadaannya di tabel permissions dicek pemanggil.
 */
export function parseRoleInput(raw: Record<string, unknown>, creating: boolean): Parsed {
    const errors: Record<string, string[]> = {}
    const add = (field: string, message: string) => (errors[field] ??= []).push(message)

    let name: string | undefined
    if (creating) {
        name = typeof raw.name === 'string' ? raw.name.trim().toLowerCase() : ''
        if (!name) add('name', 'Kode peran wajib diisi.')
        else if (!ROLE_NAME_PATTERN.test(name)) {
            add(
                'name',
                'Kode peran 2-40 karakter: huruf kecil, angka, dan garis bawah, diawali huruf.'
            )
        }
    }

    const label = typeof raw.label === 'string' ? raw.label.trim() : ''
    if (!label) add('label', 'Nama peran wajib diisi.')
    else if ([...label].length > MAX_LABEL)
        add('label', `Nama peran maksimal ${MAX_LABEL} karakter.`)

    let description: string | null = null
    if (raw.description !== undefined && raw.description !== null && raw.description !== '') {
        if (typeof raw.description !== 'string') add('description', 'Deskripsi tidak valid.')
        else if ([...raw.description].length > MAX_DESCRIPTION) {
            add('description', `Deskripsi maksimal ${MAX_DESCRIPTION} karakter.`)
        } else description = raw.description.trim() || null
    }

    if (!isScope(raw.site_scope)) add('site_scope', 'Cakupan site tidak valid.')

    const permissions: string[] = []
    if (!Array.isArray(raw.permissions)) add('permissions', 'Daftar izin harus berupa array.')
    else {
        for (const item of raw.permissions) {
            if (typeof item !== 'string' || item.length === 0 || item.length > 100) {
                add('permissions', 'Ada izin yang tidak valid.')
                break
            }
            if (!permissions.includes(item)) permissions.push(item)
        }
    }

    if (Object.keys(errors).length > 0) return { ok: false, errors }
    return {
        ok: true,
        data: {
            name,
            label,
            description,
            siteScope: raw.site_scope as SiteScope,
            permissions,
        },
    }
}

/**
 * Izin yang baru DITAMBAHKAN ke peran tetapi tidak dipegang pelaku sendiri.
 * Izin lama yang sudah ada di peran tidak dihitung (boleh dibiarkan atau dicabut).
 */
export function permissionsActorLacks(
    actorPermissions: string[],
    current: string[],
    requested: string[]
): string[] {
    return requested.filter(
        (permission) => !current.includes(permission) && !actorPermissions.includes(permission)
    )
}

/** Cakupan baru tidak boleh lebih luas dari cakupan pelaku (kecuali tidak berubah). */
export function scopeExceedsActor(
    actorScope: SiteScope,
    currentScope: SiteScope | null,
    requested: SiteScope
): boolean {
    if (currentScope === requested) return false
    return scopeRank(requested) > scopeRank(actorScope)
}
