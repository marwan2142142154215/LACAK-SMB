import { test } from '@japa/runner'
import { errors as vineErrors } from '@vinejs/vine'
import type { Access } from '#services/access'
import { attachmentDisposition, laravelSlug, mimeTypeFor, randomString } from '#services/documents'
import {
    GEOFENCE_RULE_MORPH,
    dirtyLoggedAttributes,
    geofenceRuleResource,
    loggedAttributesOf,
    type GeofenceRuleRow,
} from '#controllers/geofence_rules_controller'
import { maskedTokenRef, stringInput } from '#controllers/telegram_bindings_controller'
import { canManageStaffLink } from '#controllers/telegram_user_links_controller'
import {
    paginationFrom,
    phpInteger,
    storeGeofenceRuleValidator,
    updateGeofenceRuleValidator,
} from '#validators/rules'

function accessWith(roles: string[], organizationId: number | null): Access {
    return { userId: 1, organizationId, roles, permissions: [], grantedOrganizationIds: [] }
}

async function validationErrorsOf(promise: Promise<unknown>) {
    try {
        await promise
    } catch (error) {
        if (error instanceof vineErrors.E_VALIDATION_ERROR) {
            return Object.fromEntries(
                (error.messages as Array<{ field: string; message: string }>).map((m) => [
                    m.field,
                    m.message,
                ])
            )
        }
        throw error
    }
    return {}
}

test.group('Aturan: morph Laravel', () => {
    test('subject_type memakai satu backslash antar segmen', ({ assert }) => {
        assert.equal(GEOFENCE_RULE_MORPH, String.raw`App\Models\GeofenceRule`)
    })
})

test.group('Aturan: Str::slug & nama unduhan', () => {
    test('slug sama dengan Str::slug Laravel', ({ assert }) => {
        assert.equal(laravelSlug('Budi Santoso'), 'budi-santoso')
        assert.equal(laravelSlug('  PT. Maju_Jaya / Cabang #2 '), 'pt-maju-jaya-cabang-2')
        assert.equal(laravelSlug('José Ünïcode'), 'jose-unicode')
        assert.equal(laravelSlug('a@b'), 'a-at-b')
        assert.equal(laravelSlug('--x--'), 'x')
    })

    test('Content-Disposition seperti HeaderUtils::makeDisposition', ({ assert }) => {
        assert.equal(attachmentDisposition('a-consent.pdf'), 'attachment; filename=a-consent.pdf')
        assert.equal(attachmentDisposition('a b.pdf'), 'attachment; filename="a b.pdf"')
        assert.equal(
            attachmentDisposition('é.pdf'),
            "attachment; filename=e.pdf; filename*=utf-8''%C3%A9.pdf"
        )
    })

    test('tipe MIME dan nama acak berkas', ({ assert }) => {
        assert.equal(mimeTypeFor('x/y.PDF'), 'application/pdf')
        assert.equal(mimeTypeFor('x/y.jpg'), 'image/jpeg')
        assert.equal(mimeTypeFor('x/y.bin'), 'application/octet-stream')
        assert.match(randomString(40), /^[A-Za-z0-9]{40}$/)
    })
})

test.group('Aturan: geofence', () => {
    const rule: GeofenceRuleRow = {
        id: 5,
        organization_id: 2,
        rule_name: 'Kantor',
        allowed_ssid: null,
        allowed_ip_cidr: null,
        max_distance_meters: 100,
        center_latitude: '-6.2000000',
        center_longitude: '106.8166670',
        anchor_device_id: null,
        is_active: true,
        created_at: new Date('2026-10-25T03:45:45Z'),
    }

    test('resource: desimal jadi float, anchor_device_name hanya kalau dimuat', ({ assert }) => {
        const resource = geofenceRuleResource(rule)
        assert.equal(resource.center_latitude, -6.2)
        assert.equal(resource.center_longitude, 106.816667)
        assert.equal(resource.created_at, '2026-10-25T03:45:45.000000Z')
        assert.notProperty(resource, 'anchor_device_name')
        assert.propertyVal(
            geofenceRuleResource({ ...rule, anchor_device_name: null }),
            'anchor_device_name',
            null
        )
    })

    test('log: created mencatat semua logOnly, updated hanya yang berubah', ({ assert }) => {
        assert.deepEqual(Object.keys(loggedAttributesOf(rule)), [
            'rule_name',
            'allowed_ssid',
            'allowed_ip_cidr',
            'max_distance_meters',
            'center_latitude',
            'center_longitude',
            'is_active',
        ])
        const { attributes, old } = dirtyLoggedAttributes(rule, {
            ...rule,
            rule_name: 'Gudang',
            center_latitude: '-6.2000000',
            is_active: false,
        })
        assert.deepEqual(attributes, { rule_name: 'Gudang', is_active: false })
        assert.deepEqual(old, { rule_name: 'Kantor', is_active: true })
    })

    test('validasi: field wajib & tipe', async ({ assert }) => {
        const errors = await validationErrorsOf(
            storeGeofenceRuleValidator.validate({
                rule_name: 'x'.repeat(256),
                max_distance_meters: 0,
                center_latitude: 91,
            })
        )
        assert.equal(errors.organization_id, 'The organization id field is required.')
        assert.equal(
            errors.rule_name,
            'The rule name field must not be greater than 255 characters.'
        )
        assert.equal(
            errors.max_distance_meters,
            'The max distance meters field must be at least 1.'
        )
        assert.equal(
            errors.center_latitude,
            'The center latitude field must be between -90 and 90.'
        )
    })

    test('validasi update: semua field opsional', async ({ assert }) => {
        assert.deepEqual(await updateGeofenceRuleValidator.validate({}), {})
        const errors = await validationErrorsOf(
            updateGeofenceRuleValidator.validate({ max_distance_meters: 'abc', is_active: 'on' })
        )
        assert.equal(
            errors.max_distance_meters,
            'The max distance meters field must be an integer.'
        )
        assert.equal(errors.is_active, 'The is active field must be true or false.')
        assert.deepEqual(await updateGeofenceRuleValidator.validate({ is_active: '0' }), {
            is_active: false,
        })
    })
})

test.group('Aturan: Telegram', () => {
    test('bot_token_ref disamarkan seperti TelegramBindingResource', ({ assert }) => {
        assert.equal(maskedTokenRef('abc'), '***')
        assert.equal(maskedTokenRef('abcdef'), '******')
        assert.equal(maskedTokenRef('TELEGRAM_BOT_TOKEN'), 'TEL************KEN')
    })

    test('$request->string(): nilai skalar saja', ({ assert }) => {
        assert.equal(stringInput('123'), '123')
        assert.equal(stringInput(123), '123')
        assert.equal(stringInput(undefined), '')
        assert.equal(stringInput(['a']), '')
    })

    test('canManageStaffLink: super_admin boleh menautkan sesama super_admin', ({ assert }) => {
        assert.isTrue(
            canManageStaffLink(accessWith(['super_admin'], null), { organization_id: null })
        )
        assert.isTrue(canManageStaffLink(accessWith(['site_admin'], 3), { organization_id: 3 }))
        assert.isFalse(canManageStaffLink(accessWith(['site_admin'], 3), { organization_id: 4 }))
        assert.isFalse(
            canManageStaffLink(accessWith(['site_admin'], null), { organization_id: null })
        )
        assert.isFalse(canManageStaffLink(accessWith(['site_admin'], 3), null))
    })
})

test.group('Aturan: query daftar', () => {
    test('intval PHP & paginate()', ({ assert }) => {
        assert.equal(phpInteger('12abc'), 12)
        assert.equal(phpInteger('abc'), 0)
        assert.equal(phpInteger(undefined, 20), 20)
        assert.deepEqual(paginationFrom(undefined, undefined, 20), { page: 1, perPage: 20 })
        assert.deepEqual(paginationFrom('3', '100', 20), { page: 3, perPage: 100 })
        assert.deepEqual(paginationFrom('0', '0', 20), { page: 1, perPage: 15 })
        assert.deepEqual(paginationFrom('2x', '-5', 20), { page: 1, perPage: 15 })
    })
})
