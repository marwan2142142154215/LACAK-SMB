import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Nama site unik tanpa membedakan huruf besar/kecil & spasi berlebih (pengaman terakhir di
 * database; pengecekan utamanya ada di OrganizationsController). Kalau database sudah berisi
 * nama kembar, indeks TIDAK dibuat (migrasi tetap berhasil) dan daftar kembarannya dicetak:
 * rapikan dulu (ganti nama / hapus salah satunya), lalu jalankan SQL indeks di bawah.
 */
const INDEX = 'organizations_name_ci_unique'
const KEY = "lower(btrim(regexp_replace(name, '\\s+', ' ', 'g')))"

export default class extends BaseSchema {
    protected tableName = 'organizations'

    async up() {
        this.defer(async (db) => {
            const duplicates = await db.rawQuery(
                `SELECT ${KEY} AS key, count(*)::int AS total, string_agg(id::text, ', ' ORDER BY id) AS ids
                   FROM organizations
                  WHERE deleted_at IS NULL
                  GROUP BY 1
                 HAVING count(*) > 1`
            )
            if (duplicates.rows.length > 0) {
                console.warn(
                    `[0009] Indeks ${INDEX} dilewati: ada nama site kembar (id): ` +
                        duplicates.rows
                            .map(
                                (row: { key: string; ids: string }) => `"${row.key}" -> ${row.ids}`
                            )
                            .join('; ')
                )
                console.warn(
                    `[0009] Setelah dirapikan: CREATE UNIQUE INDEX ${INDEX} ON organizations ((${KEY})) WHERE deleted_at IS NULL;`
                )
                return
            }
            await db.rawQuery(
                `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON organizations ((${KEY})) WHERE deleted_at IS NULL`
            )
        })
    }

    async down() {
        this.schema.raw(`DROP INDEX IF EXISTS ${INDEX}`)
    }
}
