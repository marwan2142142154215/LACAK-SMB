import { test } from '@japa/runner'
import type { Access } from '#services/access'
import { canHostBriefing, canJoinBriefing, sitesOf, type BriefingRow } from '#services/briefing'

function access(roles: string[], overrides: Partial<Access> = {}): Access {
    return {
        userId: 10,
        organizationId: 1,
        roles,
        permissions: [],
        grantedOrganizationIds: [],
        ...overrides,
    }
}

function briefing(overrides: Partial<BriefingRow> = {}): BriefingRow {
    return {
        id: 1,
        title: 'Briefing pagi',
        host_user_id: 99,
        allowed_roles: ['staff_viewer'],
        allowed_organization_ids: [1],
        started_at: new Date(),
        ended_at: null,
        ...overrides,
    }
}

test.group('Briefing: siapa yang boleh memimpin & bergabung', () => {
    test('leader, admin & root boleh memulai; staf tidak', ({ assert }) => {
        assert.isTrue(canHostBriefing(access(['leader'])))
        assert.isTrue(canHostBriefing(access(['admin'])))
        assert.isTrue(canHostBriefing(access(['super_admin'])))
        assert.isFalse(canHostBriefing(access(['staff_viewer'])))
    })

    test('staf hanya bergabung kalau peran DAN site-nya diundang', ({ assert }) => {
        assert.isTrue(canJoinBriefing(access(['staff_viewer']), briefing()))
        assert.isFalse(canJoinBriefing(access(['staff_viewer'], { organizationId: 2 }), briefing()))
        assert.isFalse(
            canJoinBriefing(access(['staff_viewer']), briefing({ allowed_roles: ['leader'] }))
        )
        // Daftar site kosong = semua site.
        assert.isTrue(
            canJoinBriefing(
                access(['staff_viewer'], { organizationId: 7 }),
                briefing({ allowed_organization_ids: [] })
            )
        )
    })

    test('leader/admin cocok lewat site yang dipegangnya', ({ assert }) => {
        const leader = access(['leader'], { organizationId: null, grantedOrganizationIds: [1, 2] })
        assert.isTrue(
            canJoinBriefing(
                leader,
                briefing({ allowed_roles: ['leader'], allowed_organization_ids: [2] })
            )
        )
        assert.isFalse(
            canJoinBriefing(
                leader,
                briefing({ allowed_roles: ['leader'], allowed_organization_ids: [3] })
            )
        )
        assert.deepEqual(sitesOf(leader), [1, 2])
    })

    test('pemimpin & root selalu boleh; briefing yang selesai tertutup', ({ assert }) => {
        assert.isTrue(
            canJoinBriefing(access(['leader'], { userId: 99 }), briefing({ allowed_roles: [] }))
        )
        assert.isTrue(canJoinBriefing(access(['super_admin']), briefing({ allowed_roles: [] })))
        assert.isFalse(
            canJoinBriefing(access(['staff_viewer']), briefing({ ended_at: new Date() }))
        )
    })
})
