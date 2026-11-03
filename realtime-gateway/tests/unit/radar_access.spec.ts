import { test } from '@japa/runner'
import type { AuthenticatedUser } from '#services/BackendApiClient'
import {
    canSeeRadar,
    RADAR_ALL_ROOM,
    radarOrganizationRoom,
    radarRoomsFor,
} from '#services/RadarAccess'

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
    return {
        id: 1,
        username: 'u',
        name: 'U',
        organizationId: 3,
        roles: ['leader'],
        permissions: ['devices.view', 'radar.view'],
        accessibleOrganizationIds: [4, 5],
        watchRoles: null,
        siteScope: 'granted',
        ...overrides,
    }
}

test.group('Radar: lokasi device lewat socket', () => {
    test('butuh radar.view DAN devices.view; salah satunya kurang = tertutup', ({ assert }) => {
        assert.isTrue(canSeeRadar(user()))
        assert.isFalse(canSeeRadar(user({ permissions: ['devices.view'] })))
        assert.isFalse(canSeeRadar(user({ permissions: ['radar.view'] })))
        assert.deepEqual(radarRoomsFor(user({ permissions: ['devices.view'] })), [])
    })

    test('ruang radar mengikuti cakupan site peran', ({ assert }) => {
        assert.deepEqual(radarRoomsFor(user()), [
            radarOrganizationRoom(4),
            radarOrganizationRoom(5),
        ])
        assert.deepEqual(radarRoomsFor(user({ siteScope: 'own' })), [radarOrganizationRoom(3)])
        assert.deepEqual(radarRoomsFor(user({ siteScope: 'own', organizationId: null })), [])
        assert.deepEqual(radarRoomsFor(user({ siteScope: 'all' })), [RADAR_ALL_ROOM])
        assert.deepEqual(radarRoomsFor(user({ roles: ['super_admin'], siteScope: 'own' })), [
            RADAR_ALL_ROOM,
        ])
    })

    test('ruang radar terpisah dari ruang site (device:status tidak ikut membawa lokasi)', ({
        assert,
    }) => {
        assert.notEqual(radarOrganizationRoom(3), 'org:3')
        assert.isTrue(radarOrganizationRoom(3).startsWith('radar:'))
    })
})
