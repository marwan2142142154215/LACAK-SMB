import db from '@adonisjs/lucid/services/db'

/**
 * Nama site harus unik TANPA membedakan huruf besar/kecil dan spasi berlebih:
 * "situs1", "SitUs1", "SITUS1", dan " situs1 " dianggap sama. Site yang sudah
 * dihapus (soft delete) tidak dihitung, jadi namanya boleh dipakai lagi.
 */

/** Hapus spasi di tepi dan ringkas spasi berderet menjadi satu (nama yang disimpan). */
export function normalizeSiteName(name: string): string {
    return name.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** Ekspresi SQL yang sama dengan normalizeSiteName() + huruf kecil, untuk perbandingan & indeks unik. */
export const SITE_NAME_KEY_SQL = "lower(btrim(regexp_replace(name, '\\s+', ' ', 'g')))"

/** True kalau ada site lain (belum dihapus) dengan nama yang sama. `exceptId` = site yang sedang diubah. */
export async function siteNameTaken(name: string, exceptId?: number): Promise<boolean> {
    const query = db
        .from('organizations')
        .whereNull('deleted_at')
        .whereRaw(`${SITE_NAME_KEY_SQL} = lower(?)`, [normalizeSiteName(name)])
    if (exceptId !== undefined) query.whereNot('id', exceptId)
    return Boolean(await query.first())
}

export const SITE_NAME_TAKEN_MESSAGE = 'Nama site sudah dipakai.'
