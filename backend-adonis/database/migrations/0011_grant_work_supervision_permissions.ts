import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Menyatukan fitur kerja & pengawasan ke sistem izin. Dulu absensi, shift,
 * izin/cuti, pengumuman, peringatan staf, memimpin briefing, dan "lihat rekan
 * se-site di Live Kerja" dikunci ke NAMA PERAN (isManager/BRIEFING_HOST_ROLES/
 * seesOnlySelf), sehingga izin di menu Peran tidak berpengaruh. Migrasi ini
 * membuat izinnya dan memberikannya ke peran bawaan PERSIS seperti perilaku lama,
 * supaya tidak ada peran yang kehilangan atau mendapat kemampuan baru. Aman
 * dijalankan berulang (ON CONFLICT DO NOTHING).
 */
const NEW_PERMISSIONS = [
    'live.roster',
    'attendance.manage',
    'work-shifts.manage',
    'leave.review',
    'announcements.manage',
    'warnings.send',
    'briefing.host',
]

/** Izin kerja/pengawasan yang dulu = isManager (super_admin/admin/leader/site_admin). */
const WORK_SUPERVISION = [
    'attendance.manage',
    'work-shifts.manage',
    'leave.review',
    'announcements.manage',
    'warnings.send',
    'live.roster',
]

/** Peran bawaan -> izin yang diberikan (meniru perilaku lama persis). */
const GRANTS: Record<string, string[]> = {
    // super_admin memegang semua izin.
    super_admin: NEW_PERMISSIONS,
    // admin & leader: dulu isManager + boleh memimpin briefing.
    admin: [...WORK_SUPERVISION, 'briefing.host'],
    leader: [...WORK_SUPERVISION, 'briefing.host'],
    // site_admin: dulu isManager, tapi BUKAN host briefing.
    site_admin: WORK_SUPERVISION,
    // Bot Telegram: seesOnlySelf dulu false untuknya -> pertahankan lewat live.roster.
    telegram_bot_service: ['live.roster'],
    // staff_viewer: tidak dapat apa pun (tetap hanya melihat dirinya sendiri).
}

export default class extends BaseSchema {
    async up() {
        this.defer(async (db) => {
            const now = new Date()
            for (const name of NEW_PERMISSIONS) {
                await db
                    .table('permissions')
                    .insert({ name, guard_name: 'web', created_at: now, updated_at: now })
                    .onConflict(['name', 'guard_name'])
                    .ignore()
            }

            for (const [role, permissions] of Object.entries(GRANTS)) {
                for (const permission of permissions) {
                    await db.rawQuery(
                        `INSERT INTO role_has_permissions (permission_id, role_id)
                         SELECT p.id, r.id FROM permissions p, roles r
                          WHERE p.name = ? AND p.guard_name = 'web'
                            AND r.name = ? AND r.guard_name = 'web'
                         ON CONFLICT DO NOTHING`,
                        [permission, role]
                    )
                }
            }
        })
    }

    async down() {
        this.defer(async (db) => {
            await db.rawQuery(
                `DELETE FROM role_has_permissions
                  WHERE permission_id IN (
                    SELECT id FROM permissions WHERE name IN (${NEW_PERMISSIONS.map(() => '?').join(', ')})
                      AND guard_name = 'web'
                  )`,
                NEW_PERMISSIONS
            )
            await db
                .from('permissions')
                .where('guard_name', 'web')
                .whereIn('name', NEW_PERMISSIONS)
                .delete()
        })
    }
}
