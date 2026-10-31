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
            // Batas koneksi per proses. Ada 4 proses (api, queue, scheduler, gateway):
            // 15 x 4 = 60 koneksi, di bawah max_connections bawaan PostgreSQL (100).
            pool: { min: 2, max: 15 },
            migrations: {
                // Skema dikelola migrasi Lucid (database/migrations), mulai
                // dari 0000_baseline_schema = hasil migrasi Laravel lama.
                naturalSort: true,
                disableRollbacksInProduction: true,
            },
            // Aplikasi memakai query builder, bukan model hasil generate.
            schemaGeneration: { enabled: false },
        },
    },
})

export default dbConfig
