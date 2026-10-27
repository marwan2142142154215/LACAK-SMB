import { createHash, randomBytes } from 'node:crypto'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import PersonalAccessToken from '#models/personal_access_token'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'

async function site(name: string) {
    const [org] = await db
        .table('organizations')
        .insert({
            name,
            type: 'company_asset',
            unique_site_code: `UJI-${randomBytes(4).toString('hex').toUpperCase()}`,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    return org.id as number
}

async function person(role: string, organizationId: number | null, granted: number[] = []) {
    const suffix = randomBytes(4).toString('hex')
    const [user] = await db
        .table('users')
        .insert({
            username: `grup.${role}.${suffix}`,
            name: `Grup ${role} ${suffix}`,
            email: `grup.${role}.${suffix}@example.test`,
            password: '$2y$10$Y18XUtkwVNaSkDxG0mGKX.51ec8i1y3rdvE4Cc.QSg9izFzIo/CiO',
            organization_id: organizationId,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
        })
        .returning(['id'])
    const roleRow = await db.from('roles').where({ name: role, guard_name: 'web' }).firstOrFail()
    await db.table('model_has_roles').insert({
        role_id: roleRow.id,
        model_type: LARAVEL_USER_MORPH,
        model_id: user.id,
    })
    for (const id of granted) {
        await db.table('user_site_access').insert({
            user_id: user.id,
            organization_id: id,
            created_at: new Date(),
            updated_at: new Date(),
        })
    }
    const plain = randomBytes(20).toString('hex')
    const token = await PersonalAccessToken.create({
        tokenableType: LARAVEL_USER_MORPH,
        tokenableId: user.id,
        name: `web_dashboard-${Date.now()}`,
        deviceType: 'computer',
        token: createHash('sha256').update(plain).digest('hex'),
        abilities: '["*"]',
        expiresAt: DateTime.now().plus({ hours: 2 }),
    })
    return { id: user.id as number, bearer: `${token.id}|${plain}` }
}

test.group('Grup chat', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('staf membuat grup dengan rekan se-site, hanya anggota yang bisa membaca', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Grup')
        const other = await site('Site Grup Lain')
        const owner = await person('staff_viewer', mine)
        const friend = await person('staff_viewer', mine)
        const colleague = await person('staff_viewer', mine)
        const outsider = await person('staff_viewer', other)

        const candidates = await client
            .get('/api/v1/chat/groups/candidates')
            .bearerToken(owner.bearer)
        const ids = candidates.body().data.items.map((item: { id: number }) => item.id)
        assert.include(ids, friend.id)
        assert.notInclude(ids, outsider.id)

        const foreign = await client
            .post('/api/v1/chat/groups')
            .json({ name: 'Campur', user_ids: [outsider.id] })
            .bearerToken(owner.bearer)
        foreign.assertStatus(403)

        const created = await client
            .post('/api/v1/chat/groups')
            .json({ name: 'Tim Gudang', user_ids: [friend.id] })
            .bearerToken(owner.bearer)
        created.assertStatus(201)
        const id = created.body().data.id

        const sent = await client
            .post(`/api/v1/chat/groups/${id}/messages`)
            .json({ body: 'Stok aman?' })
            .bearerToken(owner.bearer)
        sent.assertStatus(201)
        assert.sameMembers(sent.body().data.member_ids, [owner.id, friend.id])
        const messageId = sent.body().data.id

        const list = await client.get('/api/v1/chat/groups').bearerToken(friend.bearer)
        assert.equal(list.body().data.items[0].name, 'Tim Gudang')
        assert.equal(list.body().data.items[0].unread_count, 1)

        // Bukan anggota: grup & pesannya tidak terlihat sama sekali.
        for (const path of [`/chat/groups/${id}`, `/chat/groups/${id}/messages`]) {
            const denied = await client.get(`/api/v1${path}`).bearerToken(colleague.bearer)
            denied.assertStatus(404)
        }
        const viaSiteChat = await client
            .get(`/api/v1/chat/messages/${messageId}`)
            .bearerToken(colleague.bearer)
        viaSiteChat.assertStatus(403)
        const otherList = await client.get('/api/v1/chat/groups').bearerToken(colleague.bearer)
        assert.lengthOf(otherList.body().data.items, 0)

        // Pesan grup tidak bocor ke chat site.
        const siteChat = await client
            .get('/api/v1/chat/messages')
            .qs({ organization_id: mine })
            .bearerToken(colleague.bearer)
        assert.notInclude(
            siteChat.body().data.messages.map((message: { id: number }) => message.id),
            messageId
        )

        await client
            .post(`/api/v1/chat/groups/${id}/read`)
            .json({ message_id: messageId })
            .bearerToken(friend.bearer)
        const afterRead = await client.get('/api/v1/chat/groups').bearerToken(friend.bearer)
        assert.equal(afterRead.body().data.items[0].unread_count, 0)
    })

    test('hanya pengelola yang mengatur anggota; anggota terakhir keluar = grup terhapus', async ({
        client,
        assert,
    }) => {
        const mine = await site('Site Kelola Grup')
        const owner = await person('staff_viewer', mine)
        const friend = await person('staff_viewer', mine)
        const late = await person('staff_viewer', mine)

        const created = await client
            .post('/api/v1/chat/groups')
            .json({ name: 'Shift Malam', user_ids: [friend.id] })
            .bearerToken(owner.bearer)
        const id = created.body().data.id

        const byMember = await client
            .post(`/api/v1/chat/groups/${id}/members`)
            .json({ user_ids: [late.id] })
            .bearerToken(friend.bearer)
        byMember.assertStatus(403)
        const rename = await client
            .put(`/api/v1/chat/groups/${id}`)
            .json({ name: 'Ganti' })
            .bearerToken(friend.bearer)
        rename.assertStatus(403)

        const added = await client
            .post(`/api/v1/chat/groups/${id}/members`)
            .json({ user_ids: [late.id] })
            .bearerToken(owner.bearer)
        added.assertStatus(200)

        const kicked = await client
            .delete(`/api/v1/chat/groups/${id}/members/${late.id}`)
            .bearerToken(owner.bearer)
        kicked.assertStatus(200)
        const lateView = await client.get(`/api/v1/chat/groups/${id}`).bearerToken(late.bearer)
        lateView.assertStatus(404)

        // Pengelola keluar: anggota tersisa menjadi pengelola.
        await client
            .delete(`/api/v1/chat/groups/${id}/members/${owner.id}`)
            .bearerToken(owner.bearer)
        const detail = await client.get(`/api/v1/chat/groups/${id}`).bearerToken(friend.bearer)
        assert.isTrue(detail.body().data.is_admin)

        await client
            .delete(`/api/v1/chat/groups/${id}/members/${friend.id}`)
            .bearerToken(friend.bearer)
        assert.isNull(await db.from('chat_groups').where('id', id).first())
    })
})
