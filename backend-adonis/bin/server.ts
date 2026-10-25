/*
|--------------------------------------------------------------------------
| HTTP server entrypoint
|--------------------------------------------------------------------------
*/

// Kolom timestamp Laravel disimpan tanpa zona waktu, dalam UTC (config/app.php
// backend-api). Proses ini harus UTC juga supaya jam tidak bergeser.
process.env.TZ = 'UTC'

// Kolom BIGINT (id() Laravel) dari node-postgres default-nya string -- samakan
// dengan JSON backend-api yang mengirim number (lihat catatan yang sama di
// realtime-gateway/bin/server.ts).
const { default: pg } = await import('pg')
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10))

await import('reflect-metadata')
const { Ignitor, prettyPrintError } = await import('@adonisjs/core/ignitor')

const APP_ROOT = new URL('../', import.meta.url)

const IMPORTER = (filePath: string) => {
    if (filePath.startsWith('./') || filePath.startsWith('../')) {
        return import(new URL(filePath, APP_ROOT).href)
    }
    return import(filePath)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
    .tap((app) => {
        app.booting(async () => {
            await import('#start/env')
        })
        app.listen('SIGTERM', () => app.terminate())
        app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
    })
    .httpServer()
    .start()
    .catch((error) => {
        process.exitCode = 1
        prettyPrintError(error)
    })
