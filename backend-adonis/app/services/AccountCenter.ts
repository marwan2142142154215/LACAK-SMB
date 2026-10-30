import log from '@adonisjs/core/services/logger'
import env from '#start/env'
import * as AesCbc256 from '#services/aes_cbc256'

/**
 * Klien login Account Center (layanan akun terpusat perusahaan), padanan
 * App\Services\AccountCenter backend-api. Account Center hanya memastikan
 * "email + password ini sah" -- akun lokal, status aktif, dan 2FA tetap
 * diputuskan AuthController.
 *
 * Jawaban yang bentuknya tidak dikenali SELALU ditolak, tidak pernah
 * dianggap berhasil: kegagalan seperti itu akan terlihat seperti login sukses
 * dan tidak ada yang melapor.
 */
export const AUTHENTICATED = 'authenticated'
export const REJECTED = 'rejected'
export const UNAVAILABLE = 'unavailable'
export const NOT_CONFIGURED = 'not_configured'

export type AccountCenterOutcome =
    | { state: typeof AUTHENTICATED; email: string; name: string | null }
    | { state: typeof REJECTED | typeof UNAVAILABLE | typeof NOT_CONFIGURED }

const LOGIN_PATH = '/auth/login'
const EMAIL_KEYS = ['email', 'user_email', 'username']
const NAME_KEYS = ['name', 'full_name', 'fullname', 'display_name']
const FAILURE_FLAGS = ['success', 'status', 'ok']

export type AccountCenterSettings = {
    enabled: boolean
    uri: string
    name: string
    secret: string
    timeoutMs: number
}

/** config('lacaksmb.account_center') backend-api (bawaan enabled = true, timeout 8000 ms). */
export function settings(): AccountCenterSettings {
    return {
        enabled: env.get('ACCOUNTCENTER_ENABLED') ?? true,
        uri: (env.get('ACCOUNTCENTER_URI') ?? '').trim(),
        name: (env.get('ACCOUNTCENTER_NAME') ?? '').trim(),
        secret: (env.get('ACCOUNTCENTER_SECRET')?.release() ?? '').trim(),
        timeoutMs: env.get('ACCOUNTCENTER_TIMEOUT_MS') ?? 8000,
    }
}

export function isConfigured(config: AccountCenterSettings = settings()): boolean {
    if (!config.enabled) {
        return false
    }

    // Wajib https: password ikut terkirim (walau terenkripsi kunci bersama).
    return /^https:\/\//i.test(config.uri) && config.name !== '' && config.secret !== ''
}

export async function login(
    email: string,
    password: string,
    config: AccountCenterSettings = settings()
): Promise<AccountCenterOutcome> {
    if (!isConfigured(config)) {
        return { state: NOT_CONFIGURED }
    }

    const key = AesCbc256.keyFrom(config.secret)
    const iv = AesCbc256.generateIv()

    // JSON.stringify = json_encode(JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
    // di backend-api; tanda tangan dihitung atas teks badan ini persis.
    const body = JSON.stringify({ email, password: AesCbc256.encrypt(password, key, iv) })

    let response: Response
    try {
        response = await fetch(baseUrl(config.uri) + LOGIN_PATH, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Client-Id': config.name,
                'X-Client-Iv': Buffer.from(iv, 'utf8').toString('base64'),
                'Signature': AesCbc256.encrypt(body, key, iv),
            },
            body,
            // Http::timeout() Laravel dalam detik (dibulatkan ke atas, minimal 1).
            signal: AbortSignal.timeout(Math.max(1, Math.ceil(config.timeoutMs / 1000)) * 1000),
        })
    } catch (error) {
        log.warn(
            { reason: (error as Error)?.name ?? 'Error' },
            'Account Center tidak dapat dihubungi saat login'
        )
        return { state: UNAVAILABLE }
    }

    if (response.status >= 500) {
        return { state: UNAVAILABLE }
    }

    if (response.status < 200 || response.status >= 300) {
        return { state: REJECTED }
    }

    let payload: unknown = null
    try {
        payload = JSON.parse(await response.text())
    } catch {
        payload = null
    }

    return readIdentity(payload)
}

export function readIdentity(payload: unknown): AccountCenterOutcome {
    if (!isRecord(payload)) {
        return unreadable(payload)
    }

    // Sebagian layanan menjawab 200 untuk kegagalan sambil memantulkan
    // email yang dicoba -- penanda gagal dicek SEBELUM email dibaca.
    for (const flag of FAILURE_FLAGS) {
        const value = payload[flag]
        if (value === false || value === 'error' || value === 'failed') {
            return { state: REJECTED }
        }
    }

    const source = isRecord(payload.data)
        ? payload.data
        : isRecord(payload.user)
          ? payload.user
          : payload

    const email = pickString(source, EMAIL_KEYS)
    if (email === null) {
        return unreadable(payload)
    }

    return {
        state: AUTHENTICATED,
        email: email.toLowerCase(),
        name: pickString(source, NAME_KEYS),
    }
}

function unreadable(payload: unknown): AccountCenterOutcome {
    // Hanya nama key yang dicatat, bukan nilainya (bisa berisi token).
    log.warn(
        { root_keys: isRecord(payload) ? Object.keys(payload) : null },
        'Jawaban Account Center tidak dikenali; login ditolak.'
    )
    return { state: REJECTED }
}

/**
 * Padanan is_array($v) && $v !== [] && !array_is_list($v) untuk hasil
 * json_decode PHP: objek JSON tidak kosong yang key-nya bukan 0..n-1.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false
    }
    const keys = Object.keys(value)
    return keys.length > 0 && !keys.every((key, index) => key === String(index))
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
        const value = source[key]
        if (typeof value === 'string' && phpTrim(value) !== '') {
            return phpTrim(value)
        }
    }
    return null
}

/** trim() PHP: hanya spasi, \t, \n, \r, \0, \x0B. */
const PHP_TRIM_CHARACTERS = new Set([' ', '\t', '\n', '\r', '\0', '\v'])

function phpTrim(value: string): string {
    let start = 0
    let end = value.length
    while (start < end && PHP_TRIM_CHARACTERS.has(value[start])) start++
    while (end > start && PHP_TRIM_CHARACTERS.has(value[end - 1])) end--
    return value.slice(start, end)
}

function baseUrl(uri: string): string {
    const configured = uri.replace(/\/+$/, '')
    return configured.endsWith(LOGIN_PATH) ? configured.slice(0, -LOGIN_PATH.length) : configured
}
