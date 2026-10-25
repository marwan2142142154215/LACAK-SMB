import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Token Bearer Sanctum: "{id}|{plainText}". Kolom personal_access_tokens.token
 * menyimpan SHA-256 dari bagian plainText saja. Token tanpa "{id}|" (bentuk
 * lama) dicari langsung lewat hash-nya, sama seperti Sanctum.
 */
export function parseSanctumToken(bearer: string): { id: number | null; hash: string } | null {
    const separator = bearer.indexOf('|')
    if (separator === -1) {
        return bearer ? { id: null, hash: sha256(bearer) } : null
    }

    const id = bearer.slice(0, separator)
    const plain = bearer.slice(separator + 1)
    if (!/^\d+$/.test(id) || !plain) {
        return null
    }

    return { id: Number(id), hash: sha256(plain) }
}

export function sanctumHashMatches(storedHash: string, presentedHash: string): boolean {
    const stored = Buffer.from(storedHash, 'hex')
    const presented = Buffer.from(presentedHash, 'hex')
    return stored.length === presented.length && timingSafeEqual(stored, presented)
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
}
