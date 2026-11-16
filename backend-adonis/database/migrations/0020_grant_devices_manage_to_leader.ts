import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Memberi izin `devices.manage` ("Kelola device") ke peran bawaan `leader`.
 * Dulu leader hanya bisa lihat/kunci/buka kunci/minta lokasi device, tetapi tidak
 * mendaftarkan/mengubah/menghapus device maupun membuat kode lepas perangkat
 * (yang semuanya butuh devices.manage) -- sehingga leader kena 403 di tombol itu.
 *
 * Izin `devices.manage` sudah ada di tabel permissions (seeder baseline), jadi di
 * sini cukup menautkannya ke peran leader. Hanya menyentuh pasangan leader <->
 * devices.manage; peran lain tidak berubah. Aman dijalankan berulang
 * (ON CONFLICT DO NOTHING).
 */
const PERMISSION = 'devices.manage'
const ROLE = 'leader'

export default class extends BaseSchema {
    async up() {
        this.defer(async (db) => {
            await db.rawQuery(
                `INSERT INTO role_has_permissions (permission_id, role_id)
                 SELECT p.id, r.id FROM permissions p, roles r
                  WHERE p.name = ? AND p.guard_name = 'web'
                    AND r.name = ? AND r.guard_name = 'web'
                 ON CONFLICT DO NOTHING`,
                [PERMISSION, ROLE]
            )
        })
    }

    async down() {
        this.defer(async (db) => {
            await db.rawQuery(
                `DELETE FROM role_has_permissions
                  WHERE permission_id = (
                    SELECT id FROM permissions WHERE name = ? AND guard_name = 'web'
                  )
                    AND role_id = (
                    SELECT id FROM roles WHERE name = ? AND guard_name = 'web'
                  )`,
                [PERMISSION, ROLE]
            )
        })
    }
}
