import { test } from '@japa/runner'
import {
    TRACKER_ADMIN_RECEIVER,
    TRACKER_PACKAGE_NAME,
    checksumForProvisioning,
    provisioningPayload,
    provisioningQrSvg,
} from '#services/DeviceOwnerProvisioning'

// SHA-256 dari string kosong.
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

test.group('QR provisioning Device Owner', () => {
    test('checksum hex -> base64 URL-safe tanpa padding', ({ assert }) => {
        assert.equal(
            checksumForProvisioning(EMPTY_SHA256),
            '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU'
        )
        assert.throws(() => checksumForProvisioning('bukan-hex'))
    })

    test('payload menunjuk receiver Device Admin APK build debug', ({ assert }) => {
        const payload = provisioningPayload({
            downloadUrl: 'https://contoh.test/api/v1/apk-builds/5/download?expires=1&signature=x',
            checksumSha256: EMPTY_SHA256,
        })
        assert.equal(TRACKER_PACKAGE_NAME, 'com.lacaksmb.tracker.debug')
        assert.equal(
            payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME'],
            `com.lacaksmb.tracker.debug/${TRACKER_ADMIN_RECEIVER}`
        )
        assert.isTrue(payload['android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED'])
        assert.match(
            payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'],
            /^https:\/\//
        )
    })

    test('QR berupa SVG', async ({ assert }) => {
        const svg = await provisioningQrSvg({ a: 1 })
        assert.match(svg, /^<svg/)
    })
})
