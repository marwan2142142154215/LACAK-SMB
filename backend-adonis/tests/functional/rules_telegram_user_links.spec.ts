import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { bearerFor, makeOrganization, makeUser } from './rules_helpers.js'

async function linkTelegram(userId: number, telegramUserId: string) {
    await db.table('telegram_user_links').insert({
        user_id: userId,
        telegram_user_id: telegramUserId,
        created_at: new Date(),
        updated_at: new Date(),
    })
}

/** Padanan tests/Feature/TelegramUserLinkTest.php. */
test.group('Tautan akun Telegram staf', (group) => {
    group.each.setup(() => testUtils.db().withGlobalTransaction())

    test('super_admin bisa menautkan akun staf lain super_admin (organization_id keduanya null)', async ({
        client,
        assert,
    }) => {
        // Regresi: authorizedOrganizationId() mengembalikan null baik untuk
        // "ditolak" maupun untuk "organization_id target memang null".
        const actor = await makeUser(null, 'super_admin')
        const target = await makeUser(null, 'super_admin')

        const response = await client
            .post('/api/v1/telegram-user-links')
            .bearerToken(await bearerFor(actor))
            .json({ user_id: target, telegram_user_id: '555000111' })

        response.assertStatus(201)
        response.assertBodyContains({
            success: true,
            message: 'Akun Telegram berhasil ditautkan',
            data: { telegram_user_id: '555000111', user: { id: target } },
        })
        const link = await db
            .from('telegram_user_links')
            .where('telegram_user_id', '555000111')
            .first()
        assert.exists(link)
    })

    test('site_admin TIDAK BISA menautkan staf dari site lain', async ({ client }) => {
        const orgA = await makeOrganization()
        const orgB = await makeOrganization()
        const actor = await makeUser(orgA, 'site_admin')
        const target = await makeUser(orgB, 'site_admin')

        const response = await client
            .post('/api/v1/telegram-user-links')
            .bearerToken(await bearerFor(actor))
            .json({ user_id: target, telegram_user_id: '555000222' })

        response.assertStatus(403)
        response.assertBodyContains({ message: 'Anda tidak berwenang menautkan akun staf ini' })
    })

    test('lookup balas role & permission akun staf yang ditautkan', async ({ client, assert }) => {
        const org = await makeOrganization()
        const staff = await makeUser(org, 'site_admin')
        await linkTelegram(staff, '777000888')
        const bot = await makeUser(null, 'telegram_bot_service')

        const response = await client
            .get('/api/v1/telegram-user-links-lookup')
            .qs({ telegram_user_id: '777000888' })
            .bearerToken(await bearerFor(bot))

        response.assertStatus(200)
        assert.include(response.body().data.permissions, 'devices.lock')
        assert.include(response.body().data.roles, 'site_admin')
    })

    test('staff_viewer (bukan bot) TIDAK BISA panggil lookup sama sekali', async ({ client }) => {
        const org = await makeOrganization()
        const target = await makeUser(org, 'super_admin')
        await linkTelegram(target, '999111222')
        const viewer = await makeUser(org, 'staff_viewer')

        const response = await client
            .get('/api/v1/telegram-user-links-lookup')
            .qs({ telegram_user_id: '999111222' })
            .bearerToken(await bearerFor(viewer))

        response.assertStatus(403)
    })

    test('lookup untuk telegram_user_id yang belum ditautkan balas 404', async ({ client }) => {
        const bot = await makeUser(null, 'telegram_bot_service')

        const response = await client
            .get('/api/v1/telegram-user-links-lookup')
            .qs({ telegram_user_id: '000000000' })
            .bearerToken(await bearerFor(bot))

        response.assertStatus(404)
    })

    test('site_admin hanya melihat tautan staf site-nya sendiri', async ({ client, assert }) => {
        const orgA = await makeOrganization()
        const orgB = await makeOrganization()
        const actor = await makeUser(orgA, 'site_admin')
        const own = await makeUser(orgA)
        const other = await makeUser(orgB)
        await linkTelegram(own, '111')
        await linkTelegram(other, '222')

        const response = await client
            .get('/api/v1/telegram-user-links')
            .bearerToken(await bearerFor(actor))

        response.assertStatus(200)
        const ids = response
            .body()
            .data.map((link: { telegram_user_id: string }) => link.telegram_user_id)
        assert.include(ids, '111')
        assert.notInclude(ids, '222')
    })
})
