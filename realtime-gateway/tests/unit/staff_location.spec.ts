import { test } from '@japa/runner'
import { canShareLocation, confidenceOf } from '#services/StaffLocationHub'
import type { AuthenticatedUser } from '#services/BackendApiClient'

const userWith = (permissions: string[]) => ({ permissions }) as unknown as AuthenticatedUser

test.group('StaffLocationHub', () => {
    test('confidenceOf: sumber ip atau akurasi buruk = low', ({ assert }) => {
        assert.equal(confidenceOf('ip', 5), 'low')
        assert.equal(confidenceOf('gps', null), 'low')
        assert.equal(confidenceOf('gps', 300), 'low')
        assert.equal(confidenceOf('gps', 50), 'high')
        assert.equal(confidenceOf('wifi', 100), 'high')
    })

    test('canShareLocation butuh izin location.share', ({ assert }) => {
        assert.isTrue(canShareLocation(userWith(['location.share'])))
        assert.isFalse(canShareLocation(userWith([])))
        assert.isFalse(canShareLocation(userWith(['devices.view'])))
    })
})
