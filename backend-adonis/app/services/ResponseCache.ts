import redis from '@adonisjs/redis/services/main'
import log from '@adonisjs/core/services/logger'

/**
 * Cache jawaban untuk endpoint yang sering dipanggil dan mahal dihitung:
 *
 * - Hasil disimpan di Redis `ttlSeconds` detik, dipakai bersama semua proses
 *   dan semua pengguna dengan kunci yang sama.
 * - Single-flight: permintaan yang datang bersamaan saat cache kosong
 *   menunggu satu perhitungan yang sama (tidak ada badai query ke database).
 * - Redis bermasalah -> data dihitung langsung (sengaja tidak gagal), dan
 *   masalahnya dicatat.
 */
const inflight = new Map<string, Promise<unknown>>()

export async function cached<T>(
    key: string,
    ttlSeconds: number,
    load: () => Promise<T>
): Promise<T> {
    const fullKey = `cache:${key}`

    try {
        const hit = await redis.get(fullKey)
        if (hit) return JSON.parse(hit) as T
    } catch (error) {
        log.warn({ err: error, key: fullKey }, 'Cache Redis tidak terbaca, menghitung langsung')
    }

    const pending = inflight.get(fullKey) as Promise<T> | undefined
    if (pending) return pending

    const promise = (async () => {
        const fresh = await load()
        try {
            await redis.setex(fullKey, ttlSeconds, JSON.stringify(fresh))
        } catch (error) {
            log.warn({ err: error, key: fullKey }, 'Cache Redis tidak tertulis')
        }
        return fresh
    })().finally(() => inflight.delete(fullKey))

    inflight.set(fullKey, promise)
    return promise
}
