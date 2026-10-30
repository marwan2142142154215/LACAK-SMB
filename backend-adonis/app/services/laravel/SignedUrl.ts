import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Padanan URL bertanda tangan Laravel (`URL::temporarySignedRoute()` +
 * middleware `signed`): unduhan APK, dokumen consent, dan gambar chat.
 *
 * signature = HMAC-SHA256 dengan kunci APP_KEY Laravel APA ADANYA (termasuk
 * awalan "base64:", tidak didekode) atas URL absolut tanpa parameter
 * signature. Query disusun seperti `Arr::query()` (http_build_query RFC 3986).
 */
export class LaravelUrlSigner {
    readonly #key: string
    readonly #origin: string

    /**
     * @param appKey APP_KEY Laravel, mis. "base64:..."
     * @param appUrl origin publik backend, mis. "https://api.salahmu.fun"
     */
    constructor(appKey: string, appUrl: string) {
        this.#key = appKey
        this.#origin = appUrl.replace(/\/+$/, '')
    }

    /** URL bertanda tangan untuk `path` (mis. /api/v1/apk-builds/42/download). */
    temporarySignedUrl(
        path: string,
        expiresAt: Date,
        query: Record<string, string | number> = {}
    ): string {
        const unsigned = this.#withQuery(this.#origin + path, {
            ...query,
            expires: Math.floor(expiresAt.getTime() / 1000),
        })
        return `${unsigned}&signature=${this.#sign(unsigned)}`
    }

    /**
     * Sama dengan `$request->hasValidSignature()`: tanda tangan cocok dan
     * (kalau ada) `expires` belum lewat.
     */
    hasValidSignature(
        path: string,
        query: Record<string, unknown>,
        now: Date = new Date()
    ): boolean {
        const { signature, ...rest } = query
        if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) {
            return false
        }

        const expected = Buffer.from(this.#sign(this.#withQuery(this.#origin + path, rest)), 'hex')
        if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
            return false
        }

        if (rest.expires === undefined) {
            return true
        }
        const expires = Number(rest.expires)
        return Number.isFinite(expires) && now.getTime() / 1000 <= expires
    }

    #sign(url: string): string {
        return createHmac('sha256', this.#key).update(url).digest('hex')
    }

    #withQuery(url: string, query: Record<string, unknown>): string {
        const pairs = Object.entries(query)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => `${rawUrlEncode(key)}=${rawUrlEncode(String(value))}`)
        return pairs.length ? `${url}?${pairs.join('&')}` : url
    }
}

/** PHP rawurlencode(): seperti encodeURIComponent, tapi !'()* juga dikodekan. */
function rawUrlEncode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
}
