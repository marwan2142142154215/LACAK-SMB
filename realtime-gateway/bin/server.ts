/*
|--------------------------------------------------------------------------
| HTTP server entrypoint
|--------------------------------------------------------------------------
|
| The "server.ts" file is the entrypoint for starting the AdonisJS HTTP
| server. Either you can run this file directly or use the "serve"
| command to run this file and monitor file changes
|
*/

// PALING ATAS, sebelum koneksi DB manapun dibuat: driver node-postgres (dipakai
// Lucid) secara default mengembalikan kolom BIGINT (OID 20 -- id() Laravel di
// backend-api memakai BIGSERIAL) sebagai STRING, bukan number, untuk
// menghindari potensi presisi hilang pada integer 64-bit. Laravel/PHP sisi
// backend-api TIDAK punya masalah ini, jadi device.id yang sama bisa berupa
// number (lewat REST backend-api) atau string (lewat payload socket gateway
// ini) tergantung jalurnya -- itu sumber bug nyata yang teramati: klik device
// di Radar dashboard kadang gagal menampilkan peta (Map.get(number) tidak
// ketemu kalau key tersimpan number tapi value.device_id string), dan hanya
// "sembuh" sendiri kebetulan kalau urutan event membuatnya konsisten. Baris
// ini memaksa semua kolom bigint di-parse sebagai JS number di satu tempat,
// konsisten dengan apa yang dikirim backend-api, bukan ditambal di tiap
// pemakai belakangan.
const pg = (await import('pg')).default
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10))

await import('reflect-metadata')
const { Ignitor, prettyPrintError } = await import('@adonisjs/core/ignitor')
const { createServer } = await import('node:http')
const { Server: SocketIoServer } = await import('socket.io')

/**
 * URL to the application root. AdonisJS need it to resolve
 * paths to file and directories for scaffolding commands
 */
const APP_ROOT = new URL('../', import.meta.url)

/**
 * The importer is used to import files in context of the
 * application.
 */
const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

const ignitor = new Ignitor(APP_ROOT, { importer: IMPORTER }).tap((app) => {
  app.booting(async () => {
    await import('#start/env')
  })
  app.listen('SIGTERM', () => app.terminate())
  app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
})

// Diimpor SETELAH Ignitor dikonstruksi (bukan di baris paling atas file):
// service logger AdonisJS yang dipakai #start/socket & #services/*
// butuh singleton app container sudah ada (lihat Ignitor constructor),
// walau app belum selesai boot sepenuhnya.
const { registerSocketHandlers } = await import('#start/socket')
const { startCommandDispatcher } = await import('#services/command_dispatcher')

ignitor
  .httpServer()
  .start((handler) => {
    // Node HTTP server dibuat manual (bukan dari default .start()) supaya
    // Socket.IO bisa menumpang di server yang sama, berbagi satu port.
    //
    // PENTING: request ke path /socket.io/* TIDAK boleh diteruskan ke
    // handler AdonisJS — router Adonis tidak kenal path itu dan akan balas
    // 404 lebih dulu, membuat handshake Engine.IO (polling maupun upgrade
    // websocket) gagal sebelum sempat ditangani Socket.IO sendiri.
    const httpServer = createServer((req, res) => {
      if (req.url?.startsWith('/socket.io/')) return
      return handler(req, res)
    })

    const io = new SocketIoServer(httpServer, {
      cors: { origin: '*' }, // web dashboard & APK master beda origin
    })

    registerSocketHandlers(io)

    const stopDispatcher = startCommandDispatcher(
      Number(process.env.COMMAND_POLL_INTERVAL_MS ?? 2000)
    )
    httpServer.on('close', stopDispatcher)

    return httpServer
  })
  .catch((error) => {
    process.exitCode = 1
    prettyPrintError(error)
  })
