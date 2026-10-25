import { defineConfig } from '@adonisjs/cors'

/**
 * CORS sama dengan bawaan Laravel yang dipakai backend-api (tidak ada
 * config/cors.php di sana): semua origin, semua header, TANPA credentials.
 * Dashboard (app.salahmu.fun) & APK memakai token Bearer, bukan cookie, jadi
 * credentials memang tidak perlu -- dan "*" hanya sah tanpa credentials.
 *
 * JANGAN kembalikan ke `app.inDev ? true : []`: itu menolak dashboard di
 * produksi (login gagal karena preflight ditolak) walau lolos di lokal.
 */
const corsConfig = defineConfig({
    enabled: true,
    origin: '*',
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    headers: true,
    exposeHeaders: [],
    credentials: false,
    maxAge: 90,
})

export default corsConfig
