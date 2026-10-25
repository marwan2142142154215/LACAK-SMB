import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * AES-256-CBC yang sepadan dengan App\Services\AesCbc256 backend-api (dan
 * pustaka Account Center). Bentuknya memang tidak lazim -- kunci = md5
 * heksadesimal dipakai sebagai TEKS (32 byte), IV = 16 karakter heksadesimal
 * sebagai TEKS, hasil = base64 GANDA -- tapi harus persis begini, kalau tidak
 * Account Center menolak tanda tangannya. Dijaga test vektor di
 * tests/unit/auth_account_center.spec.ts (disalin dari AccountCenterLoginTest).
 */
const CIPHER = 'aes-256-cbc'

export function keyFrom(secret: string): string {
    return createHash('md5').update(secret, 'utf8').digest('hex')
}

/** substr(md5(random_bytes(32)), 0, 16) -- 16 karakter heksadesimal. */
export function generateIv(): string {
    return createHash('md5').update(randomBytes(32)).digest('hex').slice(0, 16)
}

/**
 * openssl_encrypt(..., options 0) sudah mengembalikan base64; dibungkus
 * base64 sekali lagi supaya sama dengan pustaka Account Center.
 */
export function encrypt(plain: string, key: string, iv: string): string {
    const cipher = createCipheriv(CIPHER, Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
    const once = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
    return Buffer.from(once, 'utf8').toString('base64')
}

/** Kebalikan encrypt(); false kalau gagal (seperti openssl_decrypt). */
export function decrypt(encoded: string, key: string, iv: string): string | false {
    try {
        const once = Buffer.from(encoded, 'base64').toString('utf8')
        const decipher = createDecipheriv(CIPHER, Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
        return Buffer.concat([
            decipher.update(Buffer.from(once, 'base64')),
            decipher.final(),
        ]).toString('utf8')
    } catch {
        return false
    }
}
