import app from '@adonisjs/core/services/app'
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { randomPassword, seedRolesAndPermissions, syncRoles } from '#database/accounts'
import { hashLaravelPassword } from '#services/laravel/bcrypt'
import { LARAVEL_USER_MORPH } from '#services/laravel/index'
import env from '#start/env'

type Account = {
    username: string
    name: string
    email: string
    /** Diisi = password dari env; kosong = dibuat acak dan dicetak sekali. */
    password?: string
    isActive: boolean
    /** true = 2FA dianggap sudah diatur (akun layanan yang tidak login manusia). */
    twoFactorConfirmed: boolean
    roles: string[]
}

/**
 * Data awal sistem (`node ace db:seed`): peran & izin, akun super_admin awal,
 * dan akun layanan. Aman dijalankan ulang -- akun manusia yang sudah ada TIDAK
 * disentuh (reseed tidak boleh me-reset password/2FA); akun layanan selalu
 * disamakan. Akun dummy server uji: `node ace demo:seed-accounts`.
 */
export default class MainSeeder extends BaseSeeder {
    async run() {
        await seedRolesAndPermissions(this.client)

        // super_admin lintas site; login pertama memaksa enrollment 2FA.
        await this.createIfMissing({
            username: 'marwanmaster',
            name: 'Marwan Master',
            email: 'marwanyahabibi@gmail.com',
            password: env.get('INITIAL_SUPERADMIN_PASSWORD')?.release(),
            isActive: true,
            twoFactorConfirmed: false,
            roles: ['super_admin'],
        })
        await this.createIfMissing({
            username: 'fortunesmb',
            name: 'Fortune SMB',
            email: 'fortunesmb@lacaksmbbot.com',
            password: env.get('FORTUNESMB_SUPERADMIN_PASSWORD')?.release(),
            isActive: true,
            twoFactorConfirmed: false,
            roles: ['super_admin'],
        })

        // Pelaku aksi otomatis server (mis. auto-lock geofence) -- tidak bisa login.
        await this.upsertServiceAccount({
            username: 'system-automation',
            name: 'System Automation',
            email: 'system-automation@lacak.local',
            isActive: false,
            twoFactorConfirmed: true,
            roles: [],
        })
        // Akun layanan bot Telegram; tokennya: `node ace bot:issue-telegram-token`.
        await this.upsertServiceAccount({
            username: 'telegram-bot',
            name: 'Telegram Bot Service',
            email: 'telegram-bot@lacak.local',
            isActive: false,
            twoFactorConfirmed: true,
            roles: ['telegram_bot_service'],
        })

        // Akun uji 'root' hanya untuk pengembangan lokal.
        if (app.inDev) {
            await this.createIfMissing({
                username: 'root',
                name: 'Root (uji lokal)',
                email: 'root@lacak.local',
                password: env.get('ROOT_PASSWORD')?.release() ?? 'Root12345!',
                isActive: true,
                twoFactorConfirmed: false,
                roles: ['super_admin'],
            })
        }
    }

    private async createIfMissing(account: Account) {
        const client = this.client as QueryClientContract
        const existing = await client.from('users').where('username', account.username).first()
        if (existing) {
            await addRoles(client, existing.id, account.roles)
            return
        }

        const password = account.password || randomPassword()
        const id = await insertUser(client, account, await hashLaravelPassword(password))
        await syncRoles(client, id, account.roles)
        if (!account.password) {
            console.warn(
                `Password awal ${account.username}: ${password} (simpan & ganti setelah login pertama)`
            )
        }
    }

    private async upsertServiceAccount(account: Account) {
        const client = this.client as QueryClientContract
        const passwordHash = await hashLaravelPassword(randomPassword(40))
        const existing = await client.from('users').where('username', account.username).first()
        const id = existing ? existing.id : await insertUser(client, account, passwordHash)
        if (existing) {
            await client.from('users').where('id', id).update({
                name: account.name,
                email: account.email,
                password: passwordHash,
                organization_id: null,
                is_active: account.isActive,
                two_factor_confirmed_at: new Date(),
                updated_at: new Date(),
            })
        }
        if (account.roles.length) await syncRoles(client, id, account.roles)
    }
}

async function insertUser(
    client: QueryClientContract,
    account: Account,
    passwordHash: string
): Promise<number> {
    const now = new Date()
    const [row] = await client
        .table('users')
        .insert({
            username: account.username,
            name: account.name,
            email: account.email,
            password: passwordHash,
            organization_id: null,
            is_active: account.isActive,
            two_factor_confirmed_at: account.twoFactorConfirmed ? now : null,
            created_at: now,
            updated_at: now,
        })
        .returning('id')
    return row.id
}

/** assignRole Laravel: menambah peran tanpa mencabut yang lain. */
async function addRoles(client: QueryClientContract, userId: number, roles: string[]) {
    const current = await client
        .from('model_has_roles')
        .join('roles', 'roles.id', 'model_has_roles.role_id')
        .where('model_has_roles.model_type', LARAVEL_USER_MORPH)
        .where('model_has_roles.model_id', userId)
        .select('roles.name')
    const names = new Set(current.map((row) => row.name))
    const missing = roles.filter((role) => !names.has(role))
    if (missing.length) await syncRoles(client, userId, [...names, ...missing])
}
