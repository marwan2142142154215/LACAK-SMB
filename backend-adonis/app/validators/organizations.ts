import { randomInt } from 'node:crypto'
import vine from '@vinejs/vine'
import { laravelBoolean } from '#validators/users'

/** StoreOrganizationRequest: tipe site saat ini hanya company_asset. */
export const storeOrganizationValidator = vine.create({
    name: vine.string().maxLength(255),
    type: vine.enum(['company_asset']),
})

/** UpdateOrganizationRequest -- dua-duanya `sometimes` tanpa `nullable`. */
export const updateOrganizationValidator = vine.create({
    name: vine.string().maxLength(255).optional(),
    is_active: laravelBoolean().optional(),
})

export const UPDATE_ORGANIZATION_SOMETIMES = ['name', 'is_active']

/**
 * Str::slug($name, '') Laravel: transliterasi ke ASCII, huruf kecil, '@'
 * jadi "at", lalu semua yang bukan huruf/angka (termasuk spasi & tanda
 * hubung) dibuang. Transliterasi di sini lewat dekomposisi Unicode -- cukup
 * untuk huruf Latin beraksen ("Cabang Bandung é" -> "cabangbandunge").
 */
export function laravelSlug(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ß/g, 'ss')
        .replace(/@/g, 'at')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
}

const RANDOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** strtoupper(Str::random($length)) -- huruf/angka acak, kriptografis. */
export function randomUpperCode(length: number): string {
    let code = ''
    for (let i = 0; i < length; i++) {
        code += RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)]
    }
    return code.toUpperCase()
}

/**
 * Kode unik site dibuat server-side (StoreOrganizationRequest::
 * generatedSiteCode): diawali slug nama site supaya tetap bisa dikenali
 * manusia (mis. "devtest" -> DEVTEST-XXXXXXXX), bagian acak di belakang
 * menjaga keunikan walau dua site bernama mirip. Kolomnya varchar(32), jadi
 * prefix maksimal 22 karakter + "-" + 8 karakter acak.
 */
export function generatedSiteCode(name: string, random = randomUpperCode(8)): string {
    const slug = laravelSlug(name).toUpperCase()
    const prefix = slug !== '' ? slug.slice(0, 22) : 'SITE'
    return `${prefix}-${random}`
}
