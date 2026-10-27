import { test } from '@japa/runner'
import { errors as vineErrors } from '@vinejs/vine'
import {
    DEVICE_MORPH,
    deviceCommandResource,
    deviceResource,
    dirtyChanges,
    laravelDecimal,
    pageOf,
    perPageOf,
    phpIntval,
    violationLogResource,
    type DeviceRow,
} from '#services/device_resource'
import {
    claimDeviceValidator,
    isDigits,
    storeDeviceCommandValidator,
    updateDeviceValidator,
    verifyDeviceOtpValidator,
} from '#validators/devices'
import { generatePlainSecret, hashDeviceSecret } from '#controllers/device_enrollment_controller'
import { generateOtpCode } from '#controllers/device_otp_controller'
import { COMMAND_PERMISSIONS } from '#controllers/device_commands_controller'

function deviceRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
    return {
        id: 7,
        organization_id: 3,
        consent_document_id: 11,
        device_name: 'HP Kasir',
        device_uuid: 'uuid-1',
        android_version: '14',
        app_build_version: '1.0.0',
        site_code_embedded: 'SITE3',
        status: 'online',
        battery_level: 80,
        last_seen_at: new Date('2026-10-25T03:45:45Z'),
        enrolled_at: null,
        is_active: true,
        secret_hash: 'rahasia',
        created_by: 1,
        updated_by: 1,
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: new Date('2026-10-02T00:00:00Z'),
        ...overrides,
    }
}

/** Pesan error validasi per field, bentuk yang sama dengan errors Laravel. */
async function validationErrors(run: () => Promise<unknown>) {
    try {
        await run()
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
    return null
}

test.group('Device: bentuk resource sama dengan Laravel', () => {
    test('morph subject_type memakai satu backslash', ({ assert }) => {
        assert.equal(DEVICE_MORPH, ['App', 'Models', 'Device'].join(String.fromCharCode(92)))
    })

    test('DeviceResource: urutan kunci, tanggal ISO mikrodetik, tanpa secret_hash', ({
        assert,
    }) => {
        const json = deviceResource(deviceRow())
        assert.deepEqual(Object.keys(json), [
            'id',
            'organization_id',
            'consent_document_id',
            'device_name',
            'device_uuid',
            'android_version',
            'app_build_version',
            'status',
            'battery_level',
            'last_seen_at',
            'enrolled_at',
            'is_active',
            'created_at',
            'updated_at',
        ])
        assert.equal(json.last_seen_at, '2026-10-25T03:45:45.000000Z')
        assert.isNull(json.enrolled_at)
        assert.notProperty(json, 'secret_hash')
    })

    test('relasi yang dimuat (whenLoaded) baru muncul kalau diminta', ({ assert }) => {
        const json = deviceResource(deviceRow(), {
            organizationName: 'Site A',
            latestLocation: {
                id: 1,
                device_id: 7,
                source: 'gps',
                latitude: '-6.2000000',
                longitude: 106.8,
                ble_distance_meters: null,
                ble_rssi: null,
                recorded_at: new Date('2026-10-25T01:00:00Z'),
            },
        })
        const keys = Object.keys(json)
        assert.equal(keys[2], 'organization_name')
        assert.equal(keys[keys.length - 3], 'latest_location')
        assert.deepEqual((json as any).latest_location, {
            id: 1,
            device_id: 7,
            source: 'gps',
            latitude: '-6.2000000',
            longitude: '106.8000000',
            ble_distance_meters: null,
            ble_rssi: null,
            recorded_at: '2026-10-25T01:00:00.000000Z',
        })

        const withoutLocation = deviceResource(deviceRow(), { latestLocation: null })
        assert.isNull((withoutLocation as any).latest_location)
    })

    test('decimal:N selalu string dengan N digit', ({ assert }) => {
        assert.equal(laravelDecimal('12.50', 2), '12.50')
        assert.equal(laravelDecimal(3.1, 2), '3.10')
        assert.isNull(laravelDecimal(null, 7))
    })

    test('DeviceCommandResource & ViolationLogResource', ({ assert }) => {
        assert.deepEqual(
            deviceCommandResource({
                id: 1,
                device_id: 7,
                command_type: 'lock',
                issued_by: 2,
                issued_via: 'web_dashboard',
                status: 'pending',
                reason_note: null,
                acknowledged_at: null,
                created_at: new Date('2026-10-25T03:00:00Z'),
                updated_at: new Date('2026-10-25T03:00:00Z'),
            }),
            {
                id: 1,
                device_id: 7,
                command_type: 'lock',
                issued_by: 2,
                issued_via: 'web_dashboard',
                status: 'pending',
                reason_note: null,
                acknowledged_at: null,
                created_at: '2026-10-25T03:00:00.000000Z',
            }
        )

        const log = violationLogResource({
            id: 5,
            device_id: 7,
            geofence_rule_id: null,
            violation_type: 'wifi_mismatch',
            detected_value: 'SSID-X',
            notified_telegram: false,
            notified_dashboard: true,
            detected_at: new Date('2026-10-25T03:00:00Z'),
            created_at: new Date('2026-10-25T03:00:00Z'),
        })
        assert.notProperty(log, 'created_at')
        assert.equal(log.detected_at, '2026-10-25T03:00:00.000000Z')
    })
})

test.group('Device: paginate & intval seperti Laravel', () => {
    test('intval PHP', ({ assert }) => {
        assert.equal(phpIntval('12abc'), 12)
        assert.equal(phpIntval('abc'), 0)
        assert.equal(phpIntval(' 7'), 7)
        assert.equal(phpIntval('2.9'), 2)
        assert.equal(phpIntval('1e2'), 100)
        assert.equal(phpIntval('-5'), -5)
        assert.equal(phpIntval(null), 0)
        assert.equal(phpIntval(undefined), 0)
    })

    test('per_page: default 20, 0 = 15, negatif = tanpa batas', ({ assert }) => {
        assert.equal(perPageOf(undefined), 20)
        assert.equal(perPageOf('50'), 50)
        assert.equal(perPageOf('0'), 15)
        assert.equal(perPageOf(null), 15)
        assert.equal(perPageOf('abc'), 15)
        assert.isNull(perPageOf('-1'))
    })

    test('page: bilangan bulat >= 1, selain itu 1', ({ assert }) => {
        assert.equal(pageOf(undefined), 1)
        assert.equal(pageOf('3'), 3)
        assert.equal(pageOf('0'), 1)
        assert.equal(pageOf('-2'), 1)
        assert.equal(pageOf('2.5'), 1)
        assert.equal(pageOf('abc'), 1)
        assert.equal(pageOf('05'), 1)
    })
})

test.group('Device: aturan model', () => {
    test('isDirty: nilai sama tidak dihitung berubah', ({ assert }) => {
        const device = deviceRow()
        assert.deepEqual(dirtyChanges(device, { status: 'online', updated_by: 1 }), {})
        assert.deepEqual(dirtyChanges(device, { status: 'locked', updated_by: 1 }), {
            status: 'locked',
        })
        assert.deepEqual(dirtyChanges(device, { is_active: true }), {})
        assert.deepEqual(dirtyChanges(device, { secret_hash: null }), { secret_hash: null })
    })

    test('rahasia device: 64 hex, hash SHA-256 hex seperti hash() PHP', ({ assert }) => {
        assert.match(generatePlainSecret(), /^[0-9a-f]{64}$/)
        // hash('sha256', 'abc') di PHP.
        assert.equal(
            hashDeviceSecret('abc'),
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        )
    })

    test('OTP selalu 6 digit', ({ assert }) => {
        for (let i = 0; i < 200; i++) {
            assert.match(generateOtpCode(), /^[1-9]\d{5}$/)
        }
    })

    test('izin per jenis perintah', ({ assert }) => {
        assert.deepEqual(COMMAND_PERMISSIONS, {
            lock: 'devices.lock',
            unlock: 'devices.unlock',
            locate_now: 'devices.locate',
            start_monitor: 'devices.monitor',
            stop_monitor: 'devices.monitor',
        })
    })
})

test.group('Device: validasi dengan pesan Laravel', () => {
    test('digits:6 menerima string & angka JSON', ({ assert }) => {
        assert.isTrue(isDigits('012345', 6))
        assert.isTrue(isDigits(123456, 6))
        assert.isFalse(isDigits('12345', 6))
        assert.isFalse(isDigits('12a456', 6))
        assert.isFalse(isDigits(12345.6, 6))
    })

    test('verify OTP', async ({ assert }) => {
        assert.deepEqual(await validationErrors(() => verifyDeviceOtpValidator.validate({})), {
            device_uuid: 'The device uuid field is required.',
            code: 'The code field is required.',
        })
        assert.deepEqual(
            await validationErrors(() =>
                verifyDeviceOtpValidator.validate({ device_uuid: 5, code: '12' })
            ),
            {
                device_uuid: 'The device uuid field must be a string.',
                code: 'The code field must be 6 digits.',
            }
        )
        const ok = await verifyDeviceOtpValidator.validate({ device_uuid: 'x', code: 123456 })
        assert.equal(ok.code, '123456')
    })

    test('perintah device', async ({ assert }) => {
        assert.deepEqual(
            await validationErrors(() =>
                storeDeviceCommandValidator.validate({
                    command_type: 'reboot',
                    issued_via: 'system_auto',
                    reason_note: 'x'.repeat(256),
                })
            ),
            {
                command_type: 'The selected command type is invalid.',
                issued_via: 'The selected issued via is invalid.',
                reason_note: 'The reason note field must not be greater than 255 characters.',
            }
        )
    })

    test('update device: boolean Laravel', async ({ assert }) => {
        const ok = await updateDeviceValidator.validate({ is_active: '0' })
        assert.strictEqual(ok.is_active, false)
        assert.deepEqual(
            await validationErrors(() => updateDeviceValidator.validate({ is_active: 'on' })),
            { is_active: 'The is active field must be true or false.' }
        )
        assert.deepEqual(
            await validationErrors(() => updateDeviceValidator.validate({ device_name: null })),
            { device_name: 'The device name field must be a string.' }
        )
        assert.deepEqual(await updateDeviceValidator.validate({}), {})
    })

    test('klaim device', async ({ assert }) => {
        assert.deepEqual(
            await validationErrors(() =>
                claimDeviceValidator.validate({ device_uuid: 'x'.repeat(256) })
            ),
            { device_uuid: 'The device uuid field must not be greater than 255 characters.' }
        )
    })
})
