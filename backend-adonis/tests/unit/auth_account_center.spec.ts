import { test } from '@japa/runner'
import * as AesCbc256 from '#services/aes_cbc256'
import { AUTHENTICATED, REJECTED, isConfigured, readIdentity } from '#services/account_center'

/**
 * Vektor dari pustaka PHP Account Center yang asli (disalin dari
 * backend-api/tests/Feature/AccountCenterLoginTest.php). Kalau gagal, login
 * Account Center akan ditolak "tanda tangan tidak sah" -- jangan diubah.
 */
test.group('Auth: AesCbc256 Account Center', () => {
    test('enkripsi sama persis dengan pustaka Account Center', ({ assert }) => {
        const key = AesCbc256.keyFrom('rahasia-uji-coba')
        const iv = '0123456789abcdef'

        assert.equal(
            AesCbc256.encrypt('password-rahasia', key, iv),
            'UjRIaGlQWHRjRVVBOXJ4eGRUdlpQL0FFUTk3bS93UGpEMm9hUzNIQisrOD0='
        )
        assert.equal(AesCbc256.encrypt('a', key, iv), 'YUJZaGdCUGxCTXlSR3JMQk5ScW1tUT09')
        assert.equal(
            AesCbc256.encrypt('{"email":"a@b.c","password":"XYZ"}', key, iv),
            'ekJZck9lQTJORk4rYzNoUHU5SlZnVWJNVFZFWlljUlUzSlNCbDdac1R2N3FaRmtrejVPbFBOdTQ3K0dXMnJrUQ=='
        )
        assert.match(AesCbc256.generateIv(), /^[0-9a-f]{16}$/)
    })

    test('dekripsi membalik enkripsi, payload rusak -> false', ({ assert }) => {
        const key = AesCbc256.keyFrom('rahasia-uji-coba')
        const iv = AesCbc256.generateIv()

        assert.equal(
            AesCbc256.decrypt(AesCbc256.encrypt('Unicode Ü / ok', key, iv), key, iv),
            'Unicode Ü / ok'
        )
        assert.isFalse(AesCbc256.decrypt('bukan-payload', key, iv))
    })
})

test.group('Auth: jawaban Account Center', () => {
    test('jawaban tidak dikenali atau gagal selalu ditolak', ({ assert }) => {
        for (const payload of [null, 'sukses', 42, [], {}, { token: 'abc' }, { data: { id: 7 } }]) {
            assert.equal(readIdentity(payload).state, REJECTED)
        }

        assert.equal(readIdentity({ success: false, data: { email: 'a@b.c' } }).state, REJECTED)
        assert.equal(readIdentity({ status: 'error', email: 'a@b.c' }).state, REJECTED)
        assert.equal(readIdentity({ ok: 'failed', email: 'a@b.c' }).state, REJECTED)
        // Array JSON (list PHP) bukan record walau berisi email.
        assert.equal(readIdentity(['a@b.c']).state, REJECTED)
    })

    test('email dibaca dari data / user / akar, huruf kecil', ({ assert }) => {
        assert.deepEqual(
            readIdentity({ success: true, data: { email: 'Orang@Contoh.test', name: 'Orang' } }),
            { state: AUTHENTICATED, email: 'orang@contoh.test', name: 'Orang' }
        )
        assert.deepEqual(readIdentity({ user: { user_email: ' a@b.c ', full_name: '  ' } }), {
            state: AUTHENTICATED,
            email: 'a@b.c',
            name: null,
        })
        assert.deepEqual(readIdentity({ username: 'x@y.z' }), {
            state: AUTHENTICATED,
            email: 'x@y.z',
            name: null,
        })
    })

    test('hanya aktif kalau https, nama, dan secret terisi', ({ assert }) => {
        const base = {
            enabled: true,
            uri: 'https://account-center.test',
            name: 'lacak-smb',
            secret: 'rahasia-uji-coba',
            timeoutMs: 8000,
        }
        assert.isTrue(isConfigured(base))
        assert.isFalse(isConfigured({ ...base, enabled: false }))
        assert.isFalse(isConfigured({ ...base, uri: 'http://account-center.test' }))
        assert.isFalse(isConfigured({ ...base, name: '' }))
        assert.isFalse(isConfigured({ ...base, secret: '' }))
    })
})
