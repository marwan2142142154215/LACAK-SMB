import { SENSITIVE_PERMISSIONS } from '#services/RoleRules'

/**
 * Keterangan tiap izin untuk matriks di menu Peran. Daftar izin yang SAH tetap tabel
 * `permissions` (diisi seeder/migrasi); katalog ini hanya memberi nama, kelompok, dan
 * penjelasan dalam bahasa dashboard. Izin di database yang belum ada di sini tampil
 * di kelompok "Lainnya" dengan kodenya.
 */
type Entry = { group: string; label: string; description: string }

const CATALOG: Record<string, Entry> = {
    'organizations.manage': {
        group: 'Site & staf',
        label: 'Kelola site',
        description: 'Membuat, mengubah, dan menghapus site.',
    },
    'users.manage': {
        group: 'Site & staf',
        label: 'Kelola staf',
        description: 'Membuat/mengubah/menghapus staf, mengatur peran dan akses site mereka.',
    },
    'roles.manage': {
        group: 'Site & staf',
        label: 'Kelola peran & izin',
        description: 'Membuat peran baru dan mengatur izin serta cakupan site setiap peran.',
    },
    'devices.view': {
        group: 'Perangkat',
        label: 'Lihat device',
        description: 'Melihat daftar dan status device.',
    },
    'devices.manage': {
        group: 'Perangkat',
        label: 'Kelola device',
        description: 'Mendaftarkan, mengubah, dan menghapus device.',
    },
    'devices.lock': {
        group: 'Perangkat',
        label: 'Kunci device',
        description: 'Mengunci device dari jarak jauh.',
    },
    'devices.unlock': {
        group: 'Perangkat',
        label: 'Buka kunci device',
        description: 'Membuka kunci device (termasuk kode OTP buka kunci).',
    },
    'devices.locate': {
        group: 'Perangkat',
        label: 'Minta lokasi device',
        description: 'Meminta lokasi terkini device.',
    },
    'devices.monitor': {
        group: 'Perangkat',
        label: 'Pantau device',
        description: 'Memantau aktivitas device secara langsung.',
    },
    'geofence-rules.manage': {
        group: 'Aturan & aplikasi',
        label: 'Kelola aturan geofence',
        description: 'Membuat, mengubah, dan menghapus aturan geofence.',
    },
    'apk-builds.manage': {
        group: 'Aturan & aplikasi',
        label: 'Build & unduh APK',
        description: 'Membuat, mengunggah, dan mengunduh APK.',
    },
    'telegram.manage': {
        group: 'Aturan & aplikasi',
        label: 'Kelola Bot Telegram',
        description: 'Mengatur binding bot Telegram dan tautan akun.',
    },
    'activity-logs.view': {
        group: 'Aturan & aplikasi',
        label: 'Lihat log aktivitas',
        description: 'Membuka riwayat aktivitas sistem.',
    },
    'live.broadcast': {
        group: 'Live Kerja',
        label: 'Mulai kerja & siaran',
        description: 'Menyalakan Live Kerja dan menyiarkan kamera/layar sendiri.',
    },
    'live.watch': {
        group: 'Live Kerja',
        label: 'Pantau Live Kerja',
        description: 'Menonton siaran staf, melihat aktivitas, log wajah, rekaman, dan chat site.',
    },
    'security.manage': {
        group: 'Sistem',
        label: 'Pengaturan keamanan',
        description: 'Mengatur 2FA wajib dan daftar IP yang diizinkan.',
    },
}

export const GROUP_ORDER = [
    'Site & staf',
    'Perangkat',
    'Aturan & aplikasi',
    'Live Kerja',
    'Sistem',
    'Lainnya',
]

export type PermissionInfo = {
    name: string
    group: string
    label: string
    description: string
    /** Izin pengelolaan akses: hanya bisa diberikan oleh pemegangnya sendiri. */
    sensitive: boolean
}

export function describePermission(name: string): PermissionInfo {
    const entry = CATALOG[name]
    return {
        name,
        group: entry?.group ?? 'Lainnya',
        label: entry?.label ?? name,
        description: entry?.description ?? 'Izin tanpa keterangan.',
        sensitive: SENSITIVE_PERMISSIONS.includes(name),
    }
}
