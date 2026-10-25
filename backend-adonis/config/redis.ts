import env from '#start/env'
import { defineConfig } from '@adonisjs/redis'
import type { InferConnections } from '@adonisjs/redis/types'

/**
 * Redis yang sama dengan yang sudah berjalan di server: cache (mis. overview
 * 5 detik), rate limit, dan antrean build APK (Tahap 4). Tiap pemakaian
 * memakai awalan kunci sendiri supaya tidak bertabrakan dengan Laravel.
 */
const redisConfig = defineConfig({
    connection: 'main',

    connections: {
        main: {
            host: env.get('REDIS_HOST'),
            port: env.get('REDIS_PORT'),
            password: env.get('REDIS_PASSWORD', ''),
            db: 0,
            keyPrefix: 'lacak-adonis:',
            retryStrategy(times) {
                return times > 10 ? null : times * 50
            },
        },

        // Antrean: tanpa keyPrefix -- library antrean (BullMQ) memberi awalan
        // sendiri dan menolak keyPrefix ioredis.
        queue: {
            host: env.get('REDIS_HOST'),
            port: env.get('REDIS_PORT'),
            password: env.get('REDIS_PASSWORD', ''),
            db: 0,
            maxRetriesPerRequest: null,
        },
    },
})

export default redisConfig

declare module '@adonisjs/redis/types' {
    export interface RedisConnections extends InferConnections<typeof redisConfig> {}
}
