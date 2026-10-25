import { test } from '@japa/runner'
import { hashLaravelPassword, verifyLaravelPassword } from '#services/laravel/bcrypt'
import { LaravelEncrypter } from '#services/laravel/crypt'
import { LaravelUrlSigner } from '#services/laravel/signed_url'
import { parseSanctumToken, sanctumHashMatches } from '#services/laravel/sanctum_token'

/**
 * Vector dari Laravel ASLI (backend-api, Laravel 13) dengan kunci uji:
 * password_hash(), Encrypter::encryptString(), URL::temporarySignedRoute(),
 * dan token Sanctum. Kalau tes ini gagal, Adonis & Laravel tidak lagi bisa
 * saling membaca data yang sama -- jangan diubah supaya lolos, perbaiki kodenya.
 */
const LARAVEL = {
    appKey: 'base64:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    bcrypt: {
        password: 'rahasia-Benar-123',
        hash: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
    },
    crypt: {
        plain: 'JBSWY3DPEHPK3PXP',
        payload:
            'eyJpdiI6IldScDRnT2doYzhHQTFtVlpQbVNhOXc9PSIsInZhbHVlIjoiR0xkTlVKRkZKVFZNa1ZMM1FZU2daVlpwWmc5NDVPbk1jRkNwSzlKZzdCST0iLCJtYWMiOiI2YzI2NTZkODBlNDQxZTk2NTk1ZDc3ODFjZTU5M2FkYTgzZDIwYTM1NzNkMTVmMzcyNmVmNGY4MzBkYzY5NDY5IiwidGFnIjoiIn0=',
    },
    cryptJson: {
        plain: '["abcd-efgh","ijkl-mnop"]',
        payload:
            'eyJpdiI6Ik91K3JlMVZINzRXaFpheGFBNy9QUVE9PSIsInZhbHVlIjoidEV1QW52eFFZeTkweG5LNGJyUGVORnpFaDFtdlc2MDJ3OUk4S0dHRy9Mdz0iLCJtYWMiOiI3NjRlMTBjMjhiZThkMDFiYjkzZWI5NDg1MTljNWU3YTVkNjRlMjdiMWI5NjBkMTgxOTZhYmEzZjAyMDUyYmJiIiwidGFnIjoiIn0=',
    },
    signedUrl: {
        appUrl: 'https://api.example.test',
        url: 'https://api.example.test/api/v1/apk-builds/42/download?expires=1893456000&signature=a5ca936ae76439d05d507d05de87607a2c83b6c986120d053150147c3b0a8e07',
        path: '/api/v1/apk-builds/42/download',
        expires: 1893456000,
        signature: 'a5ca936ae76439d05d507d05de87607a2c83b6c986120d053150147c3b0a8e07',
    },
    sanctum: {
        plain: '17|j3KaCXLS1yu8UB9YWbzTyZRs11pKk1qO1hTruvd5638b3ae0',
        hash: '69757aabedae820b7ca98c3e13c35b7079d4f3eb8fbfbb735c4df6c6b81a983c',
    },
}

test.group('Laravel compat: bcrypt', () => {
    test('memverifikasi hash $2y$ buatan Laravel', async ({ assert }) => {
        assert.isTrue(await verifyLaravelPassword(LARAVEL.bcrypt.password, LARAVEL.bcrypt.hash))
        assert.isFalse(await verifyLaravelPassword('salah', LARAVEL.bcrypt.hash))
        assert.isFalse(await verifyLaravelPassword(LARAVEL.bcrypt.password, null))
        assert.isFalse(await verifyLaravelPassword(LARAVEL.bcrypt.password, 'bukan-bcrypt'))
    })

    test('hash baru berformat $2y$ dan bisa diverifikasi', async ({ assert }) => {
        const hash = await hashLaravelPassword('kata-sandi-baru', 4)
        assert.match(hash, /^\$2y\$04\$/)
        assert.isTrue(await verifyLaravelPassword('kata-sandi-baru', hash))
    })
})

test.group('Laravel compat: Crypt', () => {
    const encrypter = new LaravelEncrypter(LARAVEL.appKey)

    test('mendekripsi payload buatan Laravel', ({ assert }) => {
        assert.equal(encrypter.decryptString(LARAVEL.crypt.payload), LARAVEL.crypt.plain)
        assert.equal(encrypter.decryptString(LARAVEL.cryptJson.payload), LARAVEL.cryptJson.plain)
    })

    test('hasil enkripsi bisa dibaca balik dengan format payload Laravel', ({ assert }) => {
        const payload = encrypter.encryptString('rahasia 2FA')
        const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))

        assert.properties(decoded, ['iv', 'value', 'mac', 'tag'])
        assert.equal(encrypter.decryptString(payload), 'rahasia 2FA')
    })

    test('menolak payload yang diubah atau kunci yang salah', ({ assert }) => {
        const decoded = JSON.parse(Buffer.from(LARAVEL.crypt.payload, 'base64').toString('utf8'))
        decoded.value = Buffer.from('dirusak-dirusak!').toString('base64')
        const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64')

        assert.throws(() => encrypter.decryptString(tampered), 'MAC payload Laravel tidak valid')
        assert.throws(
            () =>
                new LaravelEncrypter(
                    `base64:${Buffer.alloc(32, 9).toString('base64')}`
                ).decryptString(LARAVEL.crypt.payload),
            'MAC payload Laravel tidak valid'
        )
    })
})

test.group('Laravel compat: signed URL', () => {
    const signer = new LaravelUrlSigner(LARAVEL.appKey, LARAVEL.signedUrl.appUrl)
    const beforeExpiry = new Date((LARAVEL.signedUrl.expires - 60) * 1000)

    test('membuat URL yang sama persis dengan Laravel', ({ assert }) => {
        assert.equal(
            signer.temporarySignedUrl(
                LARAVEL.signedUrl.path,
                new Date(LARAVEL.signedUrl.expires * 1000)
            ),
            LARAVEL.signedUrl.url
        )
    })

    test('menerima tanda tangan Laravel selama belum kedaluwarsa', ({ assert }) => {
        const query = {
            expires: String(LARAVEL.signedUrl.expires),
            signature: LARAVEL.signedUrl.signature,
        }

        assert.isTrue(signer.hasValidSignature(LARAVEL.signedUrl.path, query, beforeExpiry))
        assert.isFalse(
            signer.hasValidSignature(
                LARAVEL.signedUrl.path,
                query,
                new Date((LARAVEL.signedUrl.expires + 1) * 1000)
            )
        )
    })

    test('menolak path, expires, atau signature yang diubah', ({ assert }) => {
        const query = {
            expires: String(LARAVEL.signedUrl.expires),
            signature: LARAVEL.signedUrl.signature,
        }

        assert.isFalse(
            signer.hasValidSignature('/api/v1/apk-builds/43/download', query, beforeExpiry)
        )
        assert.isFalse(
            signer.hasValidSignature(
                LARAVEL.signedUrl.path,
                { ...query, expires: String(LARAVEL.signedUrl.expires + 3600) },
                beforeExpiry
            )
        )
        assert.isFalse(
            signer.hasValidSignature(
                LARAVEL.signedUrl.path,
                { ...query, signature: 'abc' },
                beforeExpiry
            )
        )
        assert.isFalse(
            signer.hasValidSignature(
                LARAVEL.signedUrl.path,
                { expires: query.expires },
                beforeExpiry
            )
        )
    })
})

test.group('Laravel compat: token Sanctum', () => {
    test('memecah "{id}|{plain}" dan mencocokkan hash Sanctum', ({ assert }) => {
        const parsed = parseSanctumToken(LARAVEL.sanctum.plain)

        assert.deepEqual(parsed, { id: 17, hash: LARAVEL.sanctum.hash })
        assert.isTrue(sanctumHashMatches(LARAVEL.sanctum.hash, parsed!.hash))
        assert.isFalse(
            sanctumHashMatches(LARAVEL.sanctum.hash, parseSanctumToken('17|salah')!.hash)
        )
    })

    test('menolak bentuk token yang tidak valid', ({ assert }) => {
        assert.isNull(parseSanctumToken(''))
        assert.isNull(parseSanctumToken('abc|xyz'))
        assert.isNull(parseSanctumToken('17|'))
        assert.equal(parseSanctumToken('tanpa-id')!.id, null)
    })
})
