let cachedSystemUserId: number | null = null

/**
 * ID akun "system-automation" (lihat backend-api SystemAccountSeeder),
 * dipakai sebagai issued_by saat gateway mengeluarkan perintah otomatis
 * (auto-lock geofence) supaya tetap tercatat jujur di audit trail, bukan
 * atas nama admin manusia yang tidak benar-benar menekan tombol.
 *
 * `@adonisjs/lucid/services/db` sengaja diimpor dinamis di dalam fungsi
 * (bukan di top-level file) — modul itu memakai top-level `await
 * app.booted(...)` yang hanya aman dipanggil setelah application container
 * selesai boot, dan fungsi ini hanya dipanggil saat runtime (dari socket
 * event), jauh setelah boot selesai.
 */
export async function getSystemUserId(): Promise<number> {
  if (cachedSystemUserId !== null) return cachedSystemUserId

  const { default: db } = await import('@adonisjs/lucid/services/db')
  const row = await db.from('users').where('username', 'system-automation').select('id').first()

  if (!row) {
    throw new Error(
      'Akun system-automation belum ada. Jalankan "php artisan db:seed" di backend-api.'
    )
  }

  cachedSystemUserId = row.id

  return row.id
}
