import { crc32 } from 'node:zlib'
import { test } from '@japa/runner'
import {
    generateTokenString,
    loginDeviceOf,
    normalizeInput,
    tokenNameFor,
    validationFailures,
} from '#controllers/auth_controller'
import {
    currentTimestamp,
    generateSecretKey,
    laravelRandomString,
    otpAt,
    qrCodeInlineSvg,
    qrCodeUrl,
    verifyKeyNewer,
} from '#services/two_factor'
import { phpBool } from '#services/two_factor_policy'

/**
 * Vektor dari pragmarx/google2fa ASLI (vendor backend-api):
 * oathTotp('JBSWY3DPEHPK3PXP', t) dan verifyKeyNewer(..., window 2, timestamp).
 * Kalau gagal, kode authenticator staf yang dipasang lewat Laravel ditolak.
 */
const SECRET = 'JBSWY3DPEHPK3PXP'
const GOOGLE2FA_OTP: Array<[number, string]> = [
    [1, '996554'],
    [59, '663767'],
    [56666666, '324550'],
    [58000000, '655327'],
]

test.group('Auth: TOTP sepadan google2fa', () => {
    test('kode per periode sama persis dengan google2fa', ({ assert }) => {
        for (const [timestamp, code] of GOOGLE2FA_OTP) {
            assert.equal(otpAt(SECRET, timestamp), code)
        }
        assert.equal(otpAt('ABCDEFGHIJKLMNOP', 56666666), '541083')
        // Huruf kecil diperlakukan sama (base32Decode meng-uppercase).
        assert.equal(otpAt(SECRET.toLowerCase(), 59), '663767')
    })

    test('verifyKeyNewer: window +-2 dan proteksi replay', ({ assert }) => {
        const code = '324550'
        assert.equal(verifyKeyNewer(SECRET, code, 1, 2, 56666666), 56666666)
        assert.equal(verifyKeyNewer(SECRET, code, 1, 2, 56666668), 56666666)
        assert.equal(verifyKeyNewer(SECRET, code, 1, 2, 56666664), 56666666)
        assert.isFalse(verifyKeyNewer(SECRET, code, 1, 2, 56666669))
        // Periode yang sudah terpakai tidak diterima lagi.
        assert.isFalse(verifyKeyNewer(SECRET, code, 56666666, 2, 56666666))
        assert.isFalse(verifyKeyNewer(SECRET, '000000', 1, 2, 56666666))
    })

    test('periode = floor(detik / 30)', ({ assert }) => {
        assert.equal(currentTimestamp(1_700_000_029_999), 56666667)
        assert.equal(currentTimestamp(1_700_000_010_000), 56666667)
        assert.equal(currentTimestamp(1_699_999_999_000), 56666666)
    })

    test('secret baru 16 karakter base32 dan langsung bisa dipakai', ({ assert }) => {
        const secret = generateSecretKey()
        assert.match(secret, /^[A-Z2-7]{16}$/)
        const now = currentTimestamp()
        assert.equal(verifyKeyNewer(secret, otpAt(secret, now), 1), now)
    })

    test('isi QR sama dengan Google2FA::getQRCodeUrl', async ({ assert }) => {
        assert.equal(
            qrCodeUrl('Lacak Master API', 'a b@x.com', SECRET),
            'otpauth://totp/Lacak%20Master%20API:a%20b%40x.com?secret=JBSWY3DPEHPK3PXP&issuer=Lacak%20Master%20API&algorithm=SHA1&digits=6&period=30'
        )
        const svg = await qrCodeInlineSvg('Lacak Master API', 'a@x.com', SECRET)
        assert.match(svg, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg /)
        assert.include(svg, 'width="200"')
    })
})

test.group('Auth: token & perangkat login', () => {
    test('Str::random: huruf & angka dengan panjang tepat', ({ assert }) => {
        for (const length of [10, 40, 48]) {
            assert.match(laravelRandomString(length), new RegExp('^[A-Za-z0-9]{' + length + '}$'))
        }
    })

    test('token Sanctum = 40 karakter acak + crc32b-nya', ({ assert }) => {
        const token = generateTokenString()
        assert.match(token, /^[A-Za-z0-9]{40}[0-9a-f]{8}$/)
        assert.equal(token.slice(40), crc32(token.slice(0, 40)).toString(16).padStart(8, '0'))
        // Vektor Sanctum asli (lihat laravel_compat.spec.ts).
        assert.equal(
            crc32('j3KaCXLS1yu8UB9YWbzTyZRs11pKk1qO1hTruvd5').toString(16).padStart(8, '0'),
            '638b3ae0'
        )
    })

    test('device_type: APK & browser HP = phone, browser komputer = computer', ({ assert }) => {
        assert.equal(
            loginDeviceOf(undefined, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0'),
            'computer'
        )
        assert.equal(
            loginDeviceOf(
                'web_dashboard',
                'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36'
            ),
            'phone'
        )
        assert.equal(loginDeviceOf('master_app', 'okhttp/4.12.0'), 'phone')
        assert.equal(loginDeviceOf(undefined, undefined), 'computer')
    })

    test('nama token "<client>-<unix>"', ({ assert }) => {
        const now = new Date(1_700_000_000_500)
        assert.equal(tokenNameFor('master_app', now), 'master_app-1700000000')
        assert.equal(tokenNameFor(null, now), '-1700000000')
    })
})

test.group('Auth: validasi gaya Laravel', () => {
    test('TrimStrings & ConvertEmptyStringsToNull, kecuali password tidak di-trim', ({
        assert,
    }) => {
        assert.equal(normalizeInput('username', '  staf.a1 '), 'staf.a1')
        assert.isNull(normalizeInput('username', '   '))
        assert.equal(normalizeInput('password', '  rahasia '), '  rahasia ')
        assert.isNull(normalizeInput('password', ''))
        assert.equal(normalizeInput('code', 123456), 123456)
    })

    test('pesan sama dengan Laravel', ({ assert }) => {
        const loginRules = {
            username: ['required' as const, 'string' as const],
            password: ['required' as const, 'string' as const],
            client: [
                'nullable' as const,
                'string' as const,
                { in: ['web_dashboard', 'master_app', 'telegram_bot'] },
            ],
        }

        assert.deepEqual(
            validationFailures({ username: null, password: 5, client: 'lain' }, loginRules).map(
                (failure) => [failure.field, failure.message]
            ),
            [
                ['username', 'The username field is required.'],
                ['password', 'The password field must be a string.'],
                ['client', 'The selected client is invalid.'],
            ]
        )
        assert.lengthOf(
            validationFailures({ username: 'a', password: 'b', client: null }, loginRules),
            0
        )
        assert.deepEqual(
            validationFailures(
                { setup_token: 'x', code: '12345a' },
                { setup_token: ['required', 'string'], code: ['required', { digits: 6 }] }
            ).map((failure) => failure.message),
            ['The code field must be 6 digits.']
        )
        assert.lengthOf(
            validationFailures({ code: 123456 }, { code: ['required', { digits: 6 }] }),
            0
        )
        assert.deepEqual(
            validationFailures(
                { challenge_token: null, code: 'x'.repeat(41) },
                {
                    challenge_token: ['required', 'string'],
                    code: ['required', 'string', { max: 40 }],
                }
            ).map((failure) => failure.message),
            [
                'The challenge token field is required.',
                'The code field must not be greater than 40 characters.',
            ]
        )
    })

    test('(bool) PHP atas nilai app_settings', ({ assert }) => {
        assert.isTrue(phpBool(true))
        assert.isFalse(phpBool(false))
        assert.isFalse(phpBool(null))
        assert.isFalse(phpBool(0))
        assert.isFalse(phpBool('0'))
        assert.isFalse(phpBool(''))
        assert.isFalse(phpBool([]))
        assert.isTrue(phpBool('false'))
        assert.isTrue(phpBool(1))
    })
})
