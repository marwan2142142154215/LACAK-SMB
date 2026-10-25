import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createGuardrails, generateSync } from 'otplib'
import QRCode from 'qrcode'
import redis from '@adonisjs/redis/services/main'

/**
 * TOTP 2FA yang sepadan dengan pragmarx/google2fa di backend-api (SHA1,
 * 6 digit, periode 30 detik), supaya secret yang dipasang lewat Laravel
 * tetap berlaku di sini dan sebaliknya. Kode dibangkitkan otplib (HOTP
 * dengan counter = nomor periode); pencarian window + proteksi replay
 * meniru verifyKeyNewer() google2fa persis.
 */

/** Toleransi ±2 periode (±60 detik) supaya jam authenticator yang meleset tidak selalu ditolak. */
export const OTP_WINDOW = 2

/** Maksimum percobaan kode salah per challenge sebelum sesi login dibatalkan. */
export const MAX_2FA_ATTEMPTS = 5

export const SETUP_TTL_MINUTES = 10
export const CHALLENGE_TTL_MINUTES = 5

/** Umur penanda periode TOTP terakhir yang terpakai (proteksi replay). */
const LAST_TIMESTAMP_TTL_SECONDS = 2 * 60

const KEY_REGENERATION_SECONDS = 30
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

// Secret bawaan google2fa 16 karakter base32 = 10 byte; otplib secara bawaan
// menolak secret < 16 byte, padahal secret lama di database memang 10 byte.
const guardrails = createGuardrails({ MIN_SECRET_BYTES: 10 })

/** Google2FA::generateSecretKey(): 16 karakter base32 acak. */
export function generateSecretKey(length = 16): string {
    let secret = ''
    for (let i = 0; i < length; i++) {
        secret += BASE32_ALPHABET[randomInt(BASE32_ALPHABET.length)]
    }
    return secret
}

/** Nomor periode saat ini (Google2FA::getTimestamp()). */
export function currentTimestamp(nowMs: number = Date.now()): number {
    return Math.floor(nowMs / 1000 / KEY_REGENERATION_SECONDS)
}

/** Google2FA::oathTotp(): kode 6 digit untuk satu nomor periode. */
export function otpAt(secret: string, timestamp: number): string {
    return generateSync({
        strategy: 'hotp',
        secret: secret.toUpperCase(),
        counter: timestamp,
        guardrails,
    })
}

/**
 * Google2FA::verifyKeyNewer(): nomor periode yang cocok (int) atau false.
 * Hanya periode yang LEBIH BARU dari `oldTimestamp` yang diterima, jadi kode
 * yang sama tidak bisa dipakai dua kali.
 */
export function verifyKeyNewer(
    secret: string,
    code: string,
    oldTimestamp: number,
    window: number = OTP_WINDOW,
    timestamp: number = currentTimestamp()
): number | false {
    const given = Buffer.from(code, 'utf8')
    for (
        let candidate = Math.max(timestamp - window, oldTimestamp + 1);
        candidate <= timestamp + window;
        candidate++
    ) {
        const expected = Buffer.from(otpAt(secret, candidate), 'utf8')
        if (expected.length === given.length && timingSafeEqual(expected, given)) {
            return candidate
        }
    }
    return false
}

/** Isi QR (Google2FA::getQRCodeUrl()). */
export function qrCodeUrl(company: string, holder: string, secret: string): string {
    return (
        `otpauth://totp/${rawUrlEncode(company)}:${rawUrlEncode(holder)}` +
        `?secret=${secret}&issuer=${rawUrlEncode(company)}` +
        `&algorithm=SHA1&digits=6&period=${KEY_REGENERATION_SECONDS}`
    )
}

/**
 * Google2FA::getQRCodeInline() (backend Bacon SVG, 200 px): teks SVG mentah
 * yang dipakai dashboard sebagai data URI di field qr_code_svg.
 */
export async function qrCodeInlineSvg(
    company: string,
    holder: string,
    secret: string
): Promise<string> {
    const svg = await QRCode.toString(qrCodeUrl(company, holder, secret), {
        type: 'svg',
        width: 200,
        margin: 4,
        errorCorrectionLevel: 'L',
    })
    return `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`
}

/**
 * Str::random() Laravel: huruf & angka acak (base64 tanpa / + =). Dipakai
 * untuk setup/challenge token, recovery code, dan token Sanctum.
 */
export function laravelRandomString(length: number): string {
    let result = ''
    while (result.length < length) {
        const size = length - result.length
        const bytes = randomBytes(Math.ceil(size / 3) * 3)
        result += bytes.toString('base64').replace(/[/+=]/g, '').slice(0, size)
    }
    return result
}

/** PHP rawurlencode(). */
function rawUrlEncode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
}

/*
|--------------------------------------------------------------------------
| Penyimpanan sementara (Redis)
|--------------------------------------------------------------------------
| backend-api menyimpan ini di cache Laravel dengan key yang sama; di sini di
| Redis (awalan koneksi lacak-adonis:). Login yang dimulai di satu backend
| harus diselesaikan di backend yang sama -- semua path /auth/* dialihkan
| bersamaan di nginx.
*/

export type SetupPayload = { user_id: number; secret: string }

const setupKey = (token: string) => `auth:2fa_setup:${token}`
const challengeKey = (token: string) => `auth:2fa_challenge:${token}`
const attemptsKey = (token: string) => `auth:2fa_attempts:${token}`
const lastTimestampKey = (userId: number) => `auth:2fa_last_ts:${userId}`

export async function putSetup(token: string, payload: SetupPayload) {
    await redis.set(setupKey(token), JSON.stringify(payload), 'EX', SETUP_TTL_MINUTES * 60)
}

export async function getSetup(token: string): Promise<SetupPayload | null> {
    const raw = await redis.get(setupKey(token))
    if (!raw) return null
    try {
        return JSON.parse(raw) as SetupPayload
    } catch {
        return null
    }
}

export async function forgetSetup(token: string) {
    await redis.del(setupKey(token))
}

export async function putChallenge(token: string, userId: number) {
    await redis.set(challengeKey(token), String(userId), 'EX', CHALLENGE_TTL_MINUTES * 60)
}

export async function getChallenge(token: string): Promise<number | null> {
    const raw = await redis.get(challengeKey(token))
    const userId = raw === null ? Number.NaN : Number(raw)
    return Number.isInteger(userId) && userId > 0 ? userId : null
}

export async function getAttempts(token: string): Promise<number> {
    return Number.parseInt((await redis.get(attemptsKey(token))) ?? '0', 10) || 0
}

/** Cache::put(attempts, attempts + 1, 5 menit) -- TTL ikut diperbarui tiap salah. */
export async function putAttempts(token: string, attempts: number) {
    await redis.set(attemptsKey(token), String(attempts), 'EX', CHALLENGE_TTL_MINUTES * 60)
}

export async function forgetChallenge(token: string) {
    await redis.del(challengeKey(token), attemptsKey(token))
}

export async function getLastTimestamp(userId: number): Promise<number | null> {
    const raw = await redis.get(lastTimestampKey(userId))
    if (raw === null || !/^-?\d+$/.test(raw)) return null
    return Number(raw)
}

export async function putLastTimestamp(userId: number, timestamp: number) {
    await redis.set(lastTimestampKey(userId), String(timestamp), 'EX', LAST_TIMESTAMP_TTL_SECONDS)
}
