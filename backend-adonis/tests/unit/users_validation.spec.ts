import { test } from '@japa/runner'
import { errors as vineErrors } from '@vinejs/vine'
import {
    dirtyLogged,
    ORGANIZATION_MORPH,
    organizationResource,
    pickLogged,
    routeId,
    USER_LOGGED_FIELDS,
} from '#services/user_resource'
import {
    generatedSiteCode,
    laravelSlug,
    randomUpperCode,
    storeOrganizationValidator,
    UPDATE_ORGANIZATION_SOMETIMES,
    updateOrganizationValidator,
} from '#validators/organizations'
import {
    lastPageOf,
    laravelMessage,
    laravelMessages,
    laravelPrepare,
    pageOf,
    perPageOf,
    phpBooleanFlag,
    phpIntval,
    phpTrim,
    PRESENT_NULL,
    requestInteger,
    storeUserInput,
} from '#validators/users'

async function validationErrors(run: () => Promise<unknown>) {
    try {
        await run()
    } catch (error) {
        if (error instanceof vineErrors.E_VALIDATION_ERROR) {
            return (error.messages as Array<{ field: string; message: string }>).map(
                ({ field, message }) => [field, message]
            )
        }
        throw error
    }
    return []
}

test.group('Staf & site: pesan validasi Laravel', () => {
    test('pesan bawaan Laravel dengan nama field berspasi', ({ assert }) => {
        assert.equal(
            laravelMessage('required', 'organization_id'),
            'The organization id field is required.'
        )
        assert.equal(
            laravelMessage('maxLength', 'name', { max: 255 }),
            'The name field must not be greater than 255 characters.'
        )
        assert.equal(
            laravelMessage('minLength', 'password', { min: 8 }),
            'The password field must be at least 8 characters.'
        )
        assert.equal(laravelMessage('unique', 'username'), 'The username has already been taken.')
        assert.equal(
            laravelMessage('exists', 'site_access.0'),
            'The selected site access.0 is invalid.'
        )
        assert.equal(
            laravelMessage('boolean', 'two_factor_required'),
            'The two factor required field must be true or false.'
        )
        assert.isNull(laravelMessage('aturan-lain', 'name'))
    })

    test('StoreOrganizationRequest: required & in', async ({ assert }) => {
        const errors = await validationErrors(() =>
            storeOrganizationValidator.validate(laravelPrepare({ name: '   ', type: 'lain' }), {
                messagesProvider: laravelMessages,
            })
        )
        assert.deepEqual(errors, [
            ['name', 'The name field is required.'],
            ['type', 'The selected type is invalid.'],
        ])
    })

    test('UpdateOrganizationRequest: null yang dikirim tetap divalidasi (sometimes)', async ({
        assert,
    }) => {
        const errors = await validationErrors(() =>
            updateOrganizationValidator.validate(
                laravelPrepare(
                    { name: null, is_active: '' },
                    { sometimes: UPDATE_ORGANIZATION_SOMETIMES }
                ),
                { messagesProvider: laravelMessages }
            )
        )
        assert.deepEqual(errors, [
            ['name', 'The name field must be a string.'],
            ['is_active', 'The is active field must be true or false.'],
        ])
    })

    test('boolean Laravel: hanya true/false/0/1/"0"/"1"', async ({ assert }) => {
        for (const [value, expected] of [
            [true, true],
            ['1', true],
            [1, true],
            [false, false],
            ['0', false],
            [0, false],
        ] as const) {
            const data = await updateOrganizationValidator.validate(
                { is_active: value },
                { messagesProvider: laravelMessages }
            )
            assert.strictEqual(data.is_active, expected)
        }

        for (const value of ['true', 'on', 'yes', 2]) {
            const errors = await validationErrors(() =>
                updateOrganizationValidator.validate(
                    { is_active: value },
                    { messagesProvider: laravelMessages }
                )
            )
            assert.deepEqual(errors, [['is_active', 'The is active field must be true or false.']])
        }
    })

    test('field yang tidak dikirim di update tidak ikut divalidasi', async ({ assert }) => {
        const data = await updateOrganizationValidator.validate(
            laravelPrepare({}, { sometimes: UPDATE_ORGANIZATION_SOMETIMES }),
            { messagesProvider: laravelMessages }
        )
        assert.deepEqual(data, {})
    })
})

test.group('Staf & site: persiapan input seperti middleware Laravel', () => {
    test('TrimStrings + ConvertEmptyStringsToNull, password tidak di-trim', ({ assert }) => {
        const data = laravelPrepare({
            name: '  Budi  ',
            email: '',
            password: '  rahasia  ',
            site_access: [' 3 ', ''],
            organization_id: 4,
        })
        assert.deepEqual(data, {
            name: 'Budi',
            email: null,
            password: '  rahasia  ',
            site_access: ['3', null],
            organization_id: 4,
        })
    })

    test('sometimes: null jadi penanda, required array kosong dianggap tidak dikirim', ({
        assert,
    }) => {
        const data = laravelPrepare(
            { name: '', role: 'admin', organization_ids: [] },
            { sometimes: ['name', 'email'], requiredArrays: ['organization_ids'] }
        )
        assert.strictEqual(data.name, PRESENT_NULL)
        assert.notProperty(data, 'email')
        assert.notProperty(data, 'organization_ids')
        assert.equal(data.role, 'admin')
    })

    test('username dinormalkan huruf kecil sebelum dicek unique', ({ assert }) => {
        assert.equal(storeUserInput({ username: '  Budi.Dua ' }).username, 'budi.dua')
        assert.equal(storeUserInput({ username: 'STAF.A1' }).username, 'staf.a1')
        assert.isNull(storeUserInput({ username: '   ' }).username)
        assert.equal(storeUserInput({ username: 12 }).username, 12)
    })

    test('trim() PHP hanya karakter spasi ASCII', ({ assert }) => {
        assert.equal(phpTrim(' \t\n\r\0\u000Bbudi \t'), 'budi')
        assert.equal(phpTrim(' budi'), ' budi')
    })
})

test.group('Staf & site: query daftar seperti Laravel', () => {
    test('intval() & $request->integer()', ({ assert }) => {
        assert.equal(phpIntval('12abc'), 12)
        assert.equal(phpIntval(' -3'), -3)
        assert.equal(phpIntval('abc'), 0)
        assert.equal(phpIntval(null), 0)
        assert.equal(phpIntval(7.9), 7)
        assert.equal(phpIntval(true), 1)
        assert.equal(requestInteger({}, 'organization_id'), 0)
        assert.equal(requestInteger({ organization_id: '5' }, 'organization_id'), 5)
    })

    test('$request->boolean()', ({ assert }) => {
        for (const value of ['1', 'true', 'on', 'yes', 'TRUE', true, 1]) {
            assert.isTrue(phpBooleanFlag(value), String(value))
        }
        for (const value of ['0', 'false', 'off', 'no', '', null, undefined, 2]) {
            assert.isFalse(phpBooleanFlag(value), String(value))
        }
    })

    test('per_page & page', ({ assert }) => {
        assert.equal(perPageOf({}, 20), 20)
        assert.equal(perPageOf({ per_page: '50' }, 20), 50)
        // ?per_page= (null) atau angka tidak sah -> 0 -> bawaan model (15).
        assert.equal(perPageOf({ per_page: null }, 20), 15)
        assert.equal(perPageOf({ per_page: 'abc' }, 20), 15)

        assert.equal(pageOf({}), 1)
        assert.equal(pageOf({ page: '3' }), 3)
        assert.equal(pageOf({ page: '0' }), 1)
        assert.equal(pageOf({ page: '2.5' }), 1)
        assert.equal(pageOf({ page: '03' }), 1)
        assert.equal(pageOf({ page: 4 }), 4)

        assert.equal(lastPageOf(0, 15), 1)
        assert.equal(lastPageOf(31, 15), 3)
    })

    test('parameter route bukan angka dianggap tidak ditemukan', ({ assert }) => {
        assert.equal(routeId('42'), 42)
        assert.isNull(routeId('abc'))
        assert.isNull(routeId('1.5'))
        assert.isNull(routeId('9'.repeat(20)))
        assert.isNull(routeId(undefined))
    })
})

test.group('Staf & site: kode site & log aktivitas', () => {
    test('kode site diawali slug nama (Str::slug tanpa pemisah)', ({ assert }) => {
        assert.equal(laravelSlug('Dev Test #1'), 'devtest1')
        assert.equal(laravelSlug('Cabang Bandung-Timur_2'), 'cabangbandungtimur2')
        assert.equal(laravelSlug('Café & Co @ Jakarta'), 'cafecoatjakarta')
        assert.equal(generatedSiteCode('devtest', 'ABCD1234'), 'DEVTEST-ABCD1234')
        assert.equal(generatedSiteCode('!!!', 'ABCD1234'), 'SITE-ABCD1234')
        assert.equal(generatedSiteCode('a'.repeat(40), 'ABCD1234'), `${'A'.repeat(22)}-ABCD1234`)
        assert.isAtMost(generatedSiteCode('x'.repeat(100)).length, 32)
        assert.match(randomUpperCode(8), /^[A-Z0-9]{8}$/)
    })

    test('morph Organization memakai satu backslash', ({ assert }) => {
        assert.equal(ORGANIZATION_MORPH, ['App', 'Models', 'Organization'].join('\\'))
    })

    test('logOnlyDirty: hanya field tercatat yang berubah', ({ assert }) => {
        const before = { username: 'budi', email: 'a@x.test', is_active: true, name: 'Budi' }
        assert.deepEqual(
            dirtyLogged(USER_LOGGED_FIELDS, before, { email: 'b@x.test', name: 'Baru' }),
            { attributes: { email: 'b@x.test' }, old: { email: 'a@x.test' } }
        )
        assert.isNull(dirtyLogged(USER_LOGGED_FIELDS, before, { name: 'Baru' }))
        assert.isNull(dirtyLogged(USER_LOGGED_FIELDS, before, { is_active: true }))
        assert.deepEqual(pickLogged(USER_LOGGED_FIELDS, { ...before, password: 'x' }), {
            username: 'budi',
            email: 'a@x.test',
            is_active: true,
        })
    })

    test('OrganizationResource: devices_count hanya kalau dihitung', ({ assert }) => {
        const row = {
            id: 3,
            name: 'Dev',
            type: 'company_asset',
            unique_site_code: 'DEV-ABCD1234',
            is_active: true,
            created_at: new Date('2026-10-25T03:45:45Z'),
            updated_at: new Date('2026-10-25T03:45:46Z'),
        }
        assert.deepEqual(organizationResource(row), {
            id: 3,
            name: 'Dev',
            type: 'company_asset',
            unique_site_code: 'DEV-ABCD1234',
            is_active: true,
            created_at: '2026-10-25T03:45:45.000000Z',
            updated_at: '2026-10-25T03:45:46.000000Z',
        })
        assert.deepEqual(Object.keys(organizationResource({ ...row, devices_count: 2 })), [
            'id',
            'name',
            'type',
            'unique_site_code',
            'is_active',
            'devices_count',
            'created_at',
            'updated_at',
        ])
    })
})
