import redis from '@adonisjs/redis/services/main'

/**
 * Persiapan bersama tes fungsional (dipasang di tests/bootstrap.ts). Peran &
 * izin dibuat dengan daftar yang sama dengan seeder (database/accounts.ts).
 */
export { seedRolesAndPermissions } from '#database/accounts'

/**
 * Hapus semua kunci Redis milik aplikasi ini (penghitung rate limit, token
 * 2FA, cache overview) -- setara cache "array" Laravel yang kosong di tiap
 * tes. Hanya kunci berawalan keyPrefix aplikasi ini (config/redis.ts) yang
 * dihapus: Redis lokal bisa saja dipakai proyek lain.
 */
export async function clearAppRedisKeys() {
    const raw = redis.connection('queue')
    const prefix = 'lacak-adonis:'
    let cursor = '0'
    do {
        const [next, keys] = await raw.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500)
        cursor = next
        if (keys.length) await raw.del(...keys)
    } while (cursor !== '0')
}
