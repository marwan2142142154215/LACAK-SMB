/**
 * Logger minimal tanpa dependensi ke service container AdonisJS.
 *
 * Service `@adonisjs/core/services/logger` memakai top-level `await
 * app.booted(...)`, yang hanya aman diimpor dari kode yang dijamin berjalan
 * SETELAH application container selesai di-boot (controller, provider resmi,
 * dsb). Kode gateway custom ini (socket.ts, command_dispatcher.ts, ...)
 * diimpor lebih awal dari siklus boot HTTP server, jadi memakai console biasa
 * di sini — bukan kemalasan, tapi menghindari ketergantungan urutan boot
 * yang rapuh.
 */
function format(level: string, message: string, meta?: Record<string, unknown>) {
  const time = new Date().toISOString()
  if (meta) {
    console.log(`[${time}] ${level.toUpperCase()} ${message}`, meta)
  } else {
    console.log(`[${time}] ${level.toUpperCase()} ${message}`)
  }
}

export default {
  info(message: string, meta?: Record<string, unknown>) {
    format('info', message, meta)
  },
  warn(message: string, meta?: Record<string, unknown>) {
    format('warn', message, meta)
  },
  error(message: string, meta?: Record<string, unknown>) {
    format('error', message, meta)
  },
}
