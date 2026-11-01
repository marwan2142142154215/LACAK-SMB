import { test } from '@japa/runner'
import { isLegacyLiveRoom, parseRoomName, roomName } from '#services/Livekit'

test.group('Live Kerja: nama room', () => {
    test('room format lama dikenali (site-{id} dan leaders)', ({ assert }) => {
        assert.isTrue(isLegacyLiveRoom('site-12'))
        assert.isTrue(isLegacyLiveRoom('leaders'))
    })

    test('room per peran bukan format lama', ({ assert }) => {
        assert.isFalse(isLegacyLiveRoom('site-12-staff_viewer'))
        assert.isFalse(isLegacyLiveRoom('pusat-leader'))
        assert.isFalse(isLegacyLiveRoom('site-12-'))
        assert.isFalse(isLegacyLiveRoom('lainnya'))
    })

    test('nama room bolak-balik sama dengan parseRoomName', ({ assert }) => {
        const room = { organizationId: 7, role: 'staff_viewer' }
        assert.deepEqual(parseRoomName(roomName(room)), room)
        const central = { organizationId: null, role: 'leader' }
        assert.deepEqual(parseRoomName(roomName(central)), central)
    })

    test('room format lama tidak terbaca sebagai room per peran (tidak direkam)', ({ assert }) => {
        assert.isNull(parseRoomName('site-12'))
        assert.isNull(parseRoomName('leaders'))
    })
})
