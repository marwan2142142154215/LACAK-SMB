import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { DateTime } from 'luxon'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { errors as vineErrors } from '@vinejs/vine'
import User from '#models/user'
import env from '#start/env'
import { fail, success } from '#services/api_response'
import { laravelDate, logModelEvent, WORK_SESSION_MORPH } from '#services/activity_log'
import * as AccountCenter from '#services/account_center'
import { laravelEncrypter, LARAVEL_USER_MORPH } from '#services/laravel/index'
import { verifyLaravelPassword } from '#services/laravel/bcrypt'
import { ipRejectionBody, ipRejectionFor } from '#services/ip_whitelist'
import { removeBroadcaster } from '#services/livekit'
import { permissionNamesOf, roleNamesOf } from '#services/permissions'
import * as TwoFactor from '#services/two_factor'
import { isTwoFactorRequired } from '#services/two_factor_policy'
import { closeSession, openSessionOf, openSessions, record } from '#services/work_presence'

/**
 * Padanan AuthController backend-api. Alur login:
 *  1. POST /auth/login (username ATAU email Account Center, password)
 *     - belum pernah setup 2FA  -> balas requires_2fa_setup + qr_code_svg + setup_token
 *     - sudah setup 2FA          -> balas requires_2fa + challenge_token
 *  2. POST /auth/2fa/setup/confirm (setup_token, code) -> aktifkan 2FA, keluarkan token akses
 *  3. POST /auth/2fa/verify (challenge_token, code)    -> keluarkan token akses
 *
 * Dipakai bersama oleh web dashboard, APK master, dan APK Live -- semuanya
 * wajib login lewat endpoint yang sama ini (tidak ada jalur pintas).
 */

/**
 * Idle timeout token login (TOKEN_IDLE_HOURS backend-api): tiap request
 * terautentikasi menggeser expires_at 2 jam ke depan (extendToken). Token akun
 * layanan dibuat TANPA expires_at dan tidak pernah disentuh login.
 */
export const TOKEN_IDLE_HOURS = 2

/** Penanda token yang dicabut karena akunnya login di perangkat lain (lihat handler.ts). */
export const REPLACED_TOKEN_PREFIX = 'auth:replaced_token:'

/** Nilai personal_access_tokens.device_type (perangkat tempat login). */
export const DEVICE_COMPUTER = 'computer'
export const DEVICE_PHONE = 'phone'

/** config('app.name') backend-api -- nama penerbit di aplikasi authenticator. */
const appName = () => env.get('APP_NAME') || 'Lacak Master API'

const LOGIN_CLIENTS = ['web_dashboard', 'master_app', 'telegram_bot']

type Client = typeof db | TransactionClientContract

export default class AuthController {
    async login(ctx: HttpContext) {
        const input = validate(ctx, {
            username: ['required', 'string'],
            password: ['required', 'string'],
            client: ['nullable', 'string', { in: LOGIN_CLIENTS }],
        })

        const identifier = String(input.username).trim()
        const password = String(input.password)
        let user: User | null

        // Email + Account Center terpasang -> password diverifikasi Account
        // Center, BUKAN password lokal. Username biasa tetap memakai password
        // lokal. Dua-duanya lalu lewat 2FA, kecuali super_admin mematikannya.
        if (identifier.includes('@') && AccountCenter.isConfigured()) {
            const outcome = await AccountCenter.login(identifier.toLowerCase(), password)

            if (outcome.state === AccountCenter.UNAVAILABLE) {
                return ctx.response
                    .status(503)
                    .send(
                        fail(
                            'Layanan Account Center sedang tidak dapat dihubungi. Coba lagi beberapa saat lagi.'
                        )
                    )
            }

            if (outcome.state !== AccountCenter.AUTHENTICATED) {
                return ctx.response.status(401).send(fail('Email atau password salah'))
            }

            // Account Center hanya membuktikan identitas -- akun, role, dan
            // site tetap harus sudah dibuat admin di sini (tidak dibuat otomatis).
            user = await activeUsers().whereRaw('LOWER(email) = ?', [outcome.email]).first()

            if (!user) {
                return ctx.response
                    .status(403)
                    .send(
                        fail(
                            'Akun Account Center Anda belum terdaftar di Lacak SMB. Hubungi super admin.'
                        )
                    )
            }
        } else {
            // Tidak peka huruf besar/kecil: keyboard HP sering mengapitalkan huruf pertama.
            user = await activeUsers()
                .whereRaw('LOWER(username) = ?', [identifier.toLowerCase()])
                .first()

            if (!user || !(await verifyLaravelPassword(password, user.password))) {
                return ctx.response.status(401).send(fail('Username atau password salah'))
            }
        }

        if (!user.isActive) {
            return ctx.response
                .status(403)
                .send(fail('Akun Anda dinonaktifkan. Hubungi super admin.'))
        }

        // Dicek setelah password benar: penolakan IP tidak membocorkan
        // apakah username terdaftar, dan super_admin tetap dikecualikan.
        const ipRejection = await ipRejectionFor(ctx, user.id)
        if (ipRejection) {
            return ctx.response.status(403).send(ipRejectionBody(ipRejection, ctx))
        }

        // 2FA berlaku untuk SEMUA akun tanpa pengecualian -- kecuali
        // super_admin mematikannya untuk seluruh sistem (mis. server uji).
        if (!(await isTwoFactorRequired())) {
            const token = await issueLoginToken(ctx, user)

            return success('Login berhasil', {
                access_token: token,
                token_type: 'Bearer',
                user: await userPayload(user),
            })
        }

        if (user.twoFactorConfirmedAt === null) {
            return beginTwoFactorSetup(user)
        }

        const challengeToken = TwoFactor.laravelRandomString(48)
        await TwoFactor.putChallenge(challengeToken, user.id)

        return success('Masukkan kode 2FA dari aplikasi authenticator Anda', {
            requires_2fa: true,
            challenge_token: challengeToken,
            expires_in_seconds: TwoFactor.CHALLENGE_TTL_MINUTES * 60,
        })
    }

    async confirmTwoFactorSetup(ctx: HttpContext) {
        const input = validate(ctx, {
            setup_token: ['required', 'string'],
            code: ['required', { digits: 6 }],
        })
        const setupToken = String(input.setup_token)
        const code = String(input.code)

        const payload = await TwoFactor.getSetup(setupToken)
        if (!payload) {
            return ctx.response
                .status(410)
                .send(fail('Sesi setup 2FA sudah kedaluwarsa, silakan login ulang'))
        }

        // Baseline 1 -> kembalian nomor periode yang cocok, supaya bisa
        // disimpan untuk proteksi replay.
        const matchedTimestamp = TwoFactor.verifyKeyNewer(payload.secret, code, 1)
        if (matchedTimestamp === false) {
            return ctx.response.status(422).send(fail('Kode 2FA salah'))
        }

        const user = await activeUsers().where('id', payload.user_id).firstOrFail()

        // Catat periode terpakai supaya kode setup yang sama tidak bisa
        // langsung dipakai ulang di /2fa/verify (proteksi replay).
        await TwoFactor.putLastTimestamp(user.id, matchedTimestamp)

        const recoveryCodes = Array.from({ length: 8 }, () => TwoFactor.laravelRandomString(10))

        const token = await db.transaction(async (trx) => {
            user.useTransaction(trx)
            user.merge({
                twoFactorSecret: laravelEncrypter.encryptString(payload.secret),
                twoFactorRecoveryCodes: laravelEncrypter.encryptString(
                    JSON.stringify(recoveryCodes)
                ),
                twoFactorConfirmedAt: DateTime.now(),
            })
            await user.save()

            return issueLoginToken(ctx, user, trx)
        })

        await TwoFactor.forgetSetup(setupToken)

        return success('2FA aktif, Anda berhasil login', {
            access_token: token,
            token_type: 'Bearer',
            recovery_codes: recoveryCodes,
            user: await userPayload(user),
        })
    }

    async verifyTwoFactor(ctx: HttpContext) {
        const input = validate(ctx, {
            challenge_token: ['required', 'string'],
            // Bukan digits:6 -- boleh kode TOTP 6 digit ATAU recovery code.
            code: ['required', 'string', { max: 40 }],
        })
        const challengeToken = String(input.challenge_token)

        const userId = await TwoFactor.getChallenge(challengeToken)
        if (!userId) {
            return ctx.response
                .status(410)
                .send(fail('Sesi login sudah kedaluwarsa, silakan login ulang'))
        }

        // Batasi percobaan per challenge: setelah beberapa kali salah, sesi
        // login dibatalkan supaya kode tidak bisa ditebak beruntun (selain
        // throttle per-IP di route).
        const attempts = await TwoFactor.getAttempts(challengeToken)
        if (attempts >= TwoFactor.MAX_2FA_ATTEMPTS) {
            await TwoFactor.forgetChallenge(challengeToken)
            return ctx.response
                .status(429)
                .send(fail('Terlalu banyak percobaan. Silakan login ulang.'))
        }

        const user = await activeUsers().where('id', userId).firstOrFail()

        if (!(await consumeTwoFactorCode(user, String(input.code)))) {
            await TwoFactor.putAttempts(
                challengeToken,
                (await TwoFactor.getAttempts(challengeToken)) + 1
            )
            return ctx.response.status(422).send(fail('Kode 2FA salah'))
        }

        await TwoFactor.forgetChallenge(challengeToken)

        const token = await issueLoginToken(ctx, user)

        return success('Login berhasil', {
            access_token: token,
            token_type: 'Bearer',
            user: await userPayload(user),
        })
    }

    async logout(ctx: HttpContext) {
        const user = ctx.authUser!

        // Logout = selesai kerja: sesi Live Kerja yang masih terbuka ditutup
        // sekarang, bukan menunggu heartbeat-nya habis.
        const session = await openSessionOf(user.id)
        if (session) {
            await closeSession(session, 'logout', 'work_end')
            await logModelEvent(ctx, {
                event: 'updated',
                subjectType: WORK_SESSION_MORPH,
                subjectId: session.id,
                organizationId: session.organization_id,
                attributes: { ended_at: laravelDate(session.ended_at), end_reason: 'logout' },
                old: { ended_at: null, end_reason: null },
            })
            await removeBroadcaster(session.organization_id, session.user_id)
        }

        if (await canBroadcast(user.id)) {
            await record(user.id, 'logout', null, user.organizationId)
        }

        await ctx.accessToken!.delete()
        // Token sudah dihapus: extendToken tidak boleh menyimpannya lagi.
        ctx.accessToken = undefined

        return success('Berhasil logout')
    }

    async me({ authUser }: HttpContext) {
        return success('Data user saat ini', await userPayload(authUser!))
    }

    /** Sama seperti me(), tapi route-nya tanpa perpanjangan token (dipakai gateway). */
    async session({ authUser }: HttpContext) {
        return success('Sesi masih berlaku', await userPayload(authUser!))
    }
}

/** Sama dengan AuthController::userPayload() di backend-api. */
export async function userPayload(user: User) {
    const [roles, permissions, siteRows] = await Promise.all([
        roleNamesOf(user.id),
        permissionNamesOf(user.id),
        db.from('user_site_access').where('user_id', user.id).select('organization_id'),
    ])

    return {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        organization_id: user.organizationId,
        roles,
        permissions,
        accessible_organization_ids: siteRows.map((row) => row.organization_id),
    }
}

/** $user->can('live.broadcast'): akun yang bisa Live Kerja (staf). */
async function canBroadcast(userId: number): Promise<boolean> {
    const permissions = await permissionNamesOf(userId)
    return permissions.includes('live.broadcast')
}

/** User yang belum di-soft-delete (SoftDeletes Eloquent). */
function activeUsers() {
    return User.query().withScopes((scopes) => scopes.withoutTrashed())
}

async function beginTwoFactorSetup(user: User) {
    const secret = TwoFactor.generateSecretKey()
    const setupToken = TwoFactor.laravelRandomString(48)
    await TwoFactor.putSetup(setupToken, { user_id: user.id, secret })

    return success(
        'Scan QR ini dengan Google Authenticator / Authy, lalu konfirmasi kode 6 digit',
        {
            requires_2fa_setup: true,
            setup_token: setupToken,
            secret_manual_entry: secret,
            qr_code_svg: await TwoFactor.qrCodeInlineSvg(appName(), user.email ?? '', secret),
            expires_in_seconds: TwoFactor.SETUP_TTL_MINUTES * 60,
        }
    )
}

/**
 * Verifikasi kode login kedua: TOTP (dengan toleransi clock drift + proteksi
 * replay) atau recovery code (dipakai sekali lalu hangus). True kalau sah.
 */
async function consumeTwoFactorCode(user: User, code: string): Promise<boolean> {
    // Recovery code bukan 6 digit angka -> cek & konsumsi dari daftar.
    if (!/^\d{6}$/.test(code)) {
        return useRecoveryCode(user, code)
    }

    if (!user.twoFactorSecret) {
        // Laravel: Crypt::decryptString(null) gagal -> 500. 2FA user ini
        // direset di tengah login; tetap dianggap kesalahan server.
        throw new Error('two_factor_secret kosong untuk user yang sedang verifikasi 2FA')
    }
    const secret = laravelEncrypter.decryptString(user.twoFactorSecret)

    // Baseline 1 (jauh lebih lama dari window mana pun) untuk pemakaian pertama.
    const oldTimestamp = (await TwoFactor.getLastTimestamp(user.id)) ?? 1

    // Hanya kode yang periodenya lebih baru dari kode terakhir -> kode yang
    // sama tidak bisa dipakai dua kali (replay).
    const matchedTimestamp = TwoFactor.verifyKeyNewer(secret, code, oldTimestamp)
    if (matchedTimestamp === false) {
        return false
    }

    await TwoFactor.putLastTimestamp(user.id, matchedTimestamp)
    return true
}

/** User::useRecoveryCode(): code yang cocok langsung dihapus supaya tidak bisa dipakai dua kali. */
async function useRecoveryCode(user: User, code: string): Promise<boolean> {
    const codes = recoveryCodesOf(user)
    const index = codes.indexOf(code)
    if (index === -1) {
        return false
    }

    codes.splice(index, 1)
    user.twoFactorRecoveryCodes = laravelEncrypter.encryptString(JSON.stringify(codes))
    await user.save()
    return true
}

function recoveryCodesOf(user: User): string[] {
    if (!user.twoFactorRecoveryCodes) {
        return []
    }
    const decoded: unknown = JSON.parse(laravelEncrypter.decryptString(user.twoFactorRecoveryCodes))
    if (Array.isArray(decoded)) {
        return decoded.filter((value): value is string => typeof value === 'string')
    }
    // json_encode array PHP yang key-nya tidak berurutan menjadi objek JSON.
    if (decoded && typeof decoded === 'object') {
        return Object.values(decoded).filter((value): value is string => typeof value === 'string')
    }
    return []
}

/**
 * Token login + catat "login" di log kerja (hanya akun yang bisa Live Kerja
 * -- log ini untuk jam kerja staf, bukan akun admin/bot).
 */
async function issueLoginToken(ctx: HttpContext, user: User, client: Client = db) {
    await endOtherSessions(user, client)

    const plainText = generateTokenString()
    const now = new Date()
    const [row] = await client
        .table('personal_access_tokens')
        .insert({
            tokenable_type: LARAVEL_USER_MORPH,
            tokenable_id: user.id,
            name: tokenNameFor(ctx.request.input('client', 'web_dashboard'), now),
            token: createHash('sha256').update(plainText, 'utf8').digest('hex'),
            abilities: JSON.stringify(['*']),
            device_type: loginDeviceOf(
                ctx.request.input('client'),
                ctx.request.header('user-agent')
            ),
            expires_at: new Date(now.getTime() + TOKEN_IDLE_HOURS * 3600 * 1000),
            created_at: now,
            updated_at: now,
        })
        .returning(['id'])

    if (await canBroadcast(user.id)) {
        const session =
            (await openSessions(client).where('work_sessions.user_id', user.id).first()) ?? null
        await record(user.id, 'login', session, user.organizationId, client)
    }

    return `${row.id}|${plainText}`
}

/**
 * Satu akun = satu sesi aktif: login baru mengakhiri sesi login lain akun
 * ini (web, APK Master, APK Live). Yang terbaru menang -- sesi lama yang
 * terlupa di perangkat lain tidak bisa mengunci staf keluar.
 *
 * Hanya token login (selalu punya expires_at); token akun layanan
 * (expires_at null) tidak disentuh. Id token lama diingat 2 jam supaya
 * perangkat lama diberi tahu alasannya (session_replaced di handler.ts).
 */
async function endOtherSessions(user: User, client: Client) {
    const tokens = await client
        .from('personal_access_tokens')
        .where('tokenable_type', LARAVEL_USER_MORPH)
        .where('tokenable_id', user.id)
        .whereNotNull('expires_at')
        .select('id')
    const tokenIds = tokens.map((row) => Number(row.id))

    if (tokenIds.length === 0) {
        return
    }

    const pipeline = redis.pipeline()
    for (const tokenId of tokenIds) {
        pipeline.set(`${REPLACED_TOKEN_PREFIX}${tokenId}`, '1', 'EX', TOKEN_IDLE_HOURS * 3600)
    }
    await pipeline.exec()

    await client.from('personal_access_tokens').whereIn('id', tokenIds).delete()

    // Siaran Live Kerja dari perangkat lama ikut diputus. Sesi kerjanya
    // tetap terbuka -- staf bisa "Lanjutkan siaran" dari perangkat baru.
    const session = await openSessions(client).where('work_sessions.user_id', user.id).first()
    if (session) {
        await removeBroadcaster(session.organization_id, session.user_id)
    }
}

/**
 * Sanctum generateTokenString() (SANCTUM_TOKEN_PREFIX kosong):
 * Str::random(40) + crc32b dari 40 karakter itu.
 */
export function generateTokenString(): string {
    const entropy = TwoFactor.laravelRandomString(40)
    return entropy + crc32(entropy).toString(16).padStart(8, '0')
}

/**
 * 'computer' atau 'phone' untuk ikon laptop/HP di daftar staf. APK
 * (master_app, juga dipakai APK Live) selalu HP; dashboard dari User-Agent
 * browser-nya. Login yang 2FA-nya diverifikasi di request terpisah tetap
 * dari browser yang sama, jadi User-Agent-nya sama.
 */
export function loginDeviceOf(client: unknown, userAgent: string | undefined | null): string {
    if (client === 'master_app') {
        return DEVICE_PHONE
    }
    return /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent ?? '') ? DEVICE_PHONE : DEVICE_COMPUTER
}

/** "<client>-<unix>"; client null (dikirim kosong) menjadi "" seperti konkatenasi PHP. */
export function tokenNameFor(client: unknown, now: Date = new Date()): string {
    return `${client === null || client === undefined ? '' : String(client)}-${Math.floor(now.getTime() / 1000)}`
}

/*
|--------------------------------------------------------------------------
| Validasi gaya Laravel
|--------------------------------------------------------------------------
| Aturan & pesan sama dengan $request->validate() backend-api (pesan bawaan
| Laravel berbahasa Inggris), termasuk middleware TrimStrings (kecuali
| password) dan ConvertEmptyStringsToNull yang berjalan sebelum validasi.
*/

export type Rule =
    'required' | 'nullable' | 'string' | { in: string[] } | { digits: number } | { max: number }

export function validate(ctx: HttpContext, rules: Record<string, Rule[]>): Record<string, unknown> {
    const all = ctx.request.all()
    const values: Record<string, unknown> = {}
    for (const field of Object.keys(rules)) {
        values[field] = normalizeInput(field, all[field])
    }

    const failures = validationFailures(values, rules)
    if (failures.length > 0) {
        throw new vineErrors.E_VALIDATION_ERROR(failures)
    }
    return values
}

export function normalizeInput(field: string, value: unknown): unknown {
    if (typeof value !== 'string') {
        return value
    }
    const trimmed = ['password', 'password_confirmation', 'current_password'].includes(field)
        ? value
        : value.trim()
    return trimmed === '' ? null : trimmed
}

export function validationFailures(
    values: Record<string, unknown>,
    rules: Record<string, Rule[]>
): Array<{ field: string; message: string; rule: string }> {
    const failures: Array<{ field: string; message: string; rule: string }> = []

    for (const [field, fieldRules] of Object.entries(rules)) {
        const value = values[field]
        const label = field.replace(/_/g, ' ')
        const empty =
            value === null || value === undefined || (Array.isArray(value) && value.length === 0)

        if (empty) {
            if (fieldRules.includes('required')) {
                failures.push({
                    field,
                    rule: 'required',
                    message: `The ${label} field is required.`,
                })
            }
            // Aturan lain tidak dijalankan untuk nilai kosong (seperti Laravel).
            continue
        }

        for (const rule of fieldRules) {
            if (rule === 'string' && typeof value !== 'string') {
                failures.push({
                    field,
                    rule: 'string',
                    message: `The ${label} field must be a string.`,
                })
            } else if (typeof rule === 'object' && 'in' in rule) {
                if (
                    (typeof value !== 'string' && typeof value !== 'number') ||
                    !rule.in.includes(String(value))
                ) {
                    failures.push({
                        field,
                        rule: 'in',
                        message: `The selected ${label} is invalid.`,
                    })
                }
            } else if (typeof rule === 'object' && 'digits' in rule) {
                const text =
                    typeof value === 'number' || typeof value === 'string' ? String(value) : ''
                if (!/^[0-9]*$/.test(text) || text.length !== rule.digits) {
                    failures.push({
                        field,
                        rule: 'digits',
                        message: `The ${label} field must be ${rule.digits} digits.`,
                    })
                }
            } else if (typeof rule === 'object' && 'max' in rule) {
                if (typeof value === 'string' && [...value].length > rule.max) {
                    failures.push({
                        field,
                        rule: 'max',
                        message: `The ${label} field must not be greater than ${rule.max} characters.`,
                    })
                }
            }
        }
    }

    return failures
}
