import {
    createCipheriv,
    createDecipheriv,
    createHmac,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto'

/**
 * Padanan `Crypt::encryptString()` / `decryptString()` Laravel (AES-256-CBC,
 * cipher bawaan `config/app.php`). Dipakai untuk kolom yang dienkripsi
 * backend-api: users.two_factor_secret & two_factor_recovery_codes.
 *
 * Payload = base64(JSON {iv, value, mac, tag}), value = base64 ciphertext,
 * mac = HMAC-SHA256(kunci, iv + value) dalam heksadesimal. Kunci = APP_KEY
 * Laravel setelah awalan "base64:" didekode.
 */
export class LaravelEncrypter {
    readonly #key: Buffer

    constructor(appKey: string) {
        this.#key = appKey.startsWith('base64:')
            ? Buffer.from(appKey.slice('base64:'.length), 'base64')
            : Buffer.from(appKey, 'utf8')

        if (this.#key.length !== 32) {
            throw new Error('APP_KEY Laravel harus 32 byte untuk AES-256-CBC')
        }
    }

    encryptString(plain: string): string {
        const iv = randomBytes(16)
        const cipher = createCipheriv('aes-256-cbc', this.#key, iv)
        const value = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString(
            'base64'
        )
        const ivBase64 = iv.toString('base64')
        const mac = this.#mac(ivBase64, value)

        return Buffer.from(JSON.stringify({ iv: ivBase64, value, mac, tag: '' })).toString('base64')
    }

    decryptString(payload: string): string {
        const decoded = this.#payload(payload)
        const expectedMac = Buffer.from(this.#mac(decoded.iv, decoded.value), 'hex')
        const givenMac = Buffer.from(decoded.mac, 'hex')

        if (givenMac.length !== expectedMac.length || !timingSafeEqual(givenMac, expectedMac)) {
            throw new Error('MAC payload Laravel tidak valid')
        }

        const decipher = createDecipheriv(
            'aes-256-cbc',
            this.#key,
            Buffer.from(decoded.iv, 'base64')
        )
        return Buffer.concat([
            decipher.update(Buffer.from(decoded.value, 'base64')),
            decipher.final(),
        ]).toString('utf8')
    }

    #mac(ivBase64: string, value: string): string {
        return createHmac('sha256', this.#key)
            .update(ivBase64 + value)
            .digest('hex')
    }

    #payload(payload: string): { iv: string; value: string; mac: string } {
        let decoded: unknown
        try {
            decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
        } catch {
            throw new Error('Payload Laravel tidak valid')
        }

        const candidate = decoded as Record<string, unknown> | null
        if (
            !candidate ||
            typeof candidate.iv !== 'string' ||
            typeof candidate.value !== 'string' ||
            typeof candidate.mac !== 'string' ||
            Buffer.from(candidate.iv, 'base64').length !== 16
        ) {
            throw new Error('Payload Laravel tidak valid')
        }

        return { iv: candidate.iv, value: candidate.value, mac: candidate.mac }
    }
}
