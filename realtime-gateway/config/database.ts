import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

/*
|--------------------------------------------------------------------------
| Koneksi ke database yang SAMA dengan backend-api (Laravel) — gateway ini
| tidak menyimpan data sendiri, melainkan membaca/menulis tabel yang sudah
| dibuat lewat migration Laravel (devices, device_locations, device_commands,
| geofence_rules, violation_logs). Lihat docs/skema-database.md.
|--------------------------------------------------------------------------
*/
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
        // Migration & struktur tabel dikelola oleh backend-api (Laravel),
        // bukan oleh gateway ini — mencegah dua sumber kebenaran skema.
        naturalSort: true,
        disableRollbacksInProduction: true,
      },
    },
  },
})

export default dbConfig
