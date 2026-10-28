import { randomBytes } from 'node:crypto'
import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { seedRolesAndPermissions, syncRoles, syncSiteAccess } from '#database/accounts'
import { hashLaravelPassword } from '#services/laravel/bcrypt'
import env from '#start/env'

type SiteKey = 'A' | 'B'
/** username, nama, peran, site (organization_id), akses site (admin/leader) */
type DemoAccount = [string, string, string, SiteKey | null, SiteKey[]]

const ACCOUNTS: DemoAccount[] = [
    ['root', 'Root (uji)', 'super_admin', null, []],
    ['admin.uji', 'Admin Uji', 'admin', null, ['A', 'B']],
    ['leader.uji', 'Leader Uji', 'leader', null, ['A', 'B']],
    ['siteadmin.a', 'Admin Site A', 'site_admin', 'A', []],
    ['staf.a1', 'Staf A1', 'staff_viewer', 'A', []],
    ['staf.a2', 'Staf A2', 'staff_viewer', 'A', []],
    ['staf.b1', 'Staf B1', 'staff_viewer', 'B', []],
]

/** Staf tambahan per site, untuk menguji dinding Live Kerja & log kerja dengan banyak orang. */
const EXTRA_STAFF: Record<SiteKey, [number, number]> = { A: [3, 262], B: [2, 11] }
/** Root tambahan (super_admin) selain `root`: root2 - root15 (total 15 akun root). */
const EXTRA_ROOTS: [number, number] = [2, 15]
/** Akun admin tim audit LC: auditlc1 - auditlc10, akses Site Uji A & B. */
const AUDITLC_ADMINS: [number, number] = [1, 10]
/** Akun leader: leader1 - leader20, menonton Site Uji A & B. */
const EXTRA_LEADERS: [number, number] = [1, 20]

const range = ([from, to]: [number, number]) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)

function accounts(): DemoAccount[] {
    const list = [...ACCOUNTS]
    for (const n of range(EXTRA_ROOTS)) {
        list.push([`root${n}`, `Root ${n} (uji)`, 'super_admin', null, []])
    }
    for (const n of range(AUDITLC_ADMINS)) {
        list.push([`auditlc${n}`, `Audit LC ${n}`, 'admin', null, ['A', 'B']])
    }
    for (const n of range(EXTRA_LEADERS)) {
        list.push([`leader${n}`, `Leader ${n}`, 'leader', null, ['A', 'B']])
    }
    for (const [siteKey, bounds] of Object.entries(EXTRA_STAFF) as [SiteKey, [number, number]][]) {
        for (const n of range(bounds)) {
            const code = `${siteKey.toLowerCase()}${n}`
            list.push([`staf.${code}`, `Staf ${code.toUpperCase()}`, 'staff_viewer', siteKey, []])
        }
    }
    return list
}

/**
 * Akun & site dummy untuk SERVER UJI (padanan DemoAccountsSeeder Laravel).
 * Semua akun memakai satu password: DEMO_ACCOUNTS_PASSWORD kalau diisi, kalau
 * tidak dibuat acak dan dicetak sekali. Menjalankan ulang mereset password
 * semua akun dummy -- isi DEMO_ACCOUNTS_PASSWORD dengan password lama supaya
 * tidak berubah.
 */
export default class SeedDemoAccounts extends BaseCommand {
    static commandName = 'demo:seed-accounts'
    static description = 'Buat/segarkan akun & site dummy untuk server uji'

    static options: CommandOptions = {
        startApp: true,
    }

    async run() {
        const password =
            env.get('DEMO_ACCOUNTS_PASSWORD')?.release() ||
            `Uji-${randomBytes(12).toString('base64').replace(/[/+=]/g, '').slice(0, 10)}`
        // Satu hash untuk semua akun (passwordnya sama): bcrypt ratusan kali lambat.
        const passwordHash = await hashLaravelPassword(password)
        const list = accounts()

        await db.transaction(async (trx) => {
            await seedRolesAndPermissions(trx)
            const sites: Record<SiteKey, number> = {
                A: await site(trx, 'Site Uji A'),
                B: await site(trx, 'Site Uji B'),
            }

            for (const [username, name, role, siteKey, access] of list) {
                const now = new Date()
                const values = {
                    name,
                    email: `${username}@uji.salahmu.fun`,
                    password: passwordHash,
                    organization_id: siteKey ? sites[siteKey] : null,
                    is_active: true,
                    // Akun dummy yang pernah dihapus dihidupkan lagi (username unik).
                    deleted_at: null,
                    updated_at: now,
                }
                const existing = await trx.from('users').where('username', username).first()
                let id: number
                if (existing) {
                    id = existing.id
                    await trx.from('users').where('id', id).update(values)
                } else {
                    const [row] = await trx
                        .table('users')
                        .insert({ ...values, username, created_at: now })
                        .returning('id')
                    id = row.id
                }
                await syncRoles(trx, id, [role])
                await syncSiteAccess(
                    trx,
                    id,
                    access.map((key) => sites[key])
                )
            }
        })

        this.logger.warning(
            'Akun dummy server uji (password sama untuk semua, hanya ditampilkan sekali):'
        )
        const table = this.ui.table()
        table.head(['Username', 'Peran', 'Site'])
        for (const [username, , role, siteKey, access] of list) {
            table.row([
                username,
                role,
                siteKey
                    ? `Site Uji ${siteKey}`
                    : access.length
                      ? `Akses: Site Uji ${access.join(' & ')}`
                      : 'Semua site',
            ])
        }
        table.render()
        this.logger.info(`Password: ${password}`)
    }
}

async function site(client: QueryClientContract, name: string): Promise<number> {
    const existing = await client
        .from('organizations')
        .where('name', name)
        .whereNull('deleted_at')
        .first()
    if (existing) return existing.id
    const now = new Date()
    const code = randomBytes(6).toString('hex').slice(0, 8).toUpperCase()
    const [row] = await client
        .table('organizations')
        .insert({
            name,
            type: 'company_asset',
            unique_site_code: `UJI-${code}`,
            is_active: true,
            created_at: now,
            updated_at: now,
        })
        .returning('id')
    return row.id
}
