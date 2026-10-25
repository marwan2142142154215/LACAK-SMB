import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

const dbConfig = defineConfig({
    connection: 'postgres',
    connections: {
        postgres: {
            client: 'pg',
            connection: {
                host: env.get('DB_HOST'),
                port: env.get('DB_PORT'),
                user: env.get('DB_USER'),
                password: env.get('DB_PASSWORD'),
                database: env.get('DB_DATABASE'),
            },
            migrations: {
                // Selama migrasi, skema masih dikelola backend-api (Laravel).
                // Migrasi Lucid baru dipakai setelah Tahap 5 (baseline).
                naturalSort: true,
                disableRollbacksInProduction: true,
            },
        },
    },
})

export default dbConfig
