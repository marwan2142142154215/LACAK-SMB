import { createRouter, createWebHistory } from 'vue-router'

import { checkIpAccess } from '@/lib/ipAccess'

const routes = [
    {
        path: '/login',
        name: 'login',
        component: () => import('@/views/LoginView.vue'),
        meta: { guestOnly: true },
    },
    {
        // Pengganti halaman login untuk IP di luar whitelist (lihat beforeEach).
        path: '/akses-dibatasi',
        name: 'ip-restricted',
        component: () => import('@/views/IpRestrictedView.vue'),
        meta: { guestOnly: true },
    },
    {
        path: '/',
        component: () => import('@/layouts/AppShell.vue'),
        meta: { requiresAuth: true },
        children: [
            {
                path: '',
                name: 'radar',
                component: () => import('@/views/RadarView.vue'),
                // Radar menampilkan device & pelanggaran: izin Lihat device.
                meta: { permission: 'devices.view' },
            },
            {
                path: 'live',
                name: 'live',
                component: () => import('@/views/LiveView.vue'),
                // Menonton ATAU menyiarkan Live Kerja.
                meta: { permission: ['live.watch', 'live.broadcast'] },
            },
            {
                path: 'briefing',
                name: 'briefing',
                component: () => import('@/views/BriefingView.vue'),
            },
            {
                path: 'chat',
                name: 'chat',
                component: () => import('@/views/ChatView.vue'),
                // Chat site dilayani backend hanya untuk pemegang live.watch.
                meta: { permission: 'live.watch' },
            },
            {
                path: 'absensi',
                name: 'attendance',
                component: () => import('@/views/AttendanceView.vue'),
            },
            {
                path: 'izin',
                name: 'leave',
                component: () => import('@/views/LeaveView.vue'),
            },
            {
                path: 'pengumuman',
                name: 'announcements',
                component: () => import('@/views/AnnouncementsView.vue'),
            },
            {
                path: 'rekaman',
                name: 'recordings',
                component: () => import('@/views/RecordingsView.vue'),
                meta: { permission: 'live.watch' },
            },
            {
                path: 'aktivitas',
                name: 'activity',
                component: () => import('@/views/ActivityView.vue'),
                meta: { permission: 'live.watch' },
            },
            {
                path: 'wajah',
                name: 'face-log',
                component: () => import('@/views/FaceLogView.vue'),
                meta: { permission: 'live.watch' },
            },
            // Alamat lama "Log kerja" -- isinya sekarang bagian dari Aktivitas user.
            { path: 'live/log', name: 'work-log', redirect: { name: 'activity' } },
            {
                path: 'devices',
                name: 'devices',
                component: () => import('@/views/DevicesView.vue'),
                meta: { permission: 'devices.view' },
            },
            {
                path: 'organizations',
                name: 'organizations',
                component: () => import('@/views/OrganizationsView.vue'),
                meta: { requiresSuperAdmin: true },
            },
            {
                path: 'geofence-rules',
                name: 'geofence-rules',
                component: () => import('@/views/GeofenceRulesView.vue'),
                meta: { permission: 'geofence-rules.manage' },
            },
            {
                path: 'apk-builds',
                name: 'apk-builds',
                component: () => import('@/views/ApkBuildsView.vue'),
                // Root, admin, leader, admin site -- staf tidak bisa build/unduh APK.
                meta: { permission: 'apk-builds.manage' },
            },
            {
                path: 'telegram-bindings',
                name: 'telegram-bindings',
                component: () => import('@/views/TelegramBindingsView.vue'),
                meta: { permission: 'telegram.manage' },
            },
            {
                path: 'staff',
                name: 'staff',
                component: () => import('@/views/StaffView.vue'),
                // Peran ber-cakupan "site yang diberikan" (admin, leader, ...): hanya menonaktifkan /
                // mengaktifkan staf di site-nya.
                meta: { staffAccess: true },
            },
            {
                path: 'peran',
                name: 'roles',
                component: () => import('@/views/RolesView.vue'),
                meta: { permission: 'roles.manage' },
            },
            {
                path: 'settings',
                name: 'settings',
                component: () => import('@/views/SettingsView.vue'),
                meta: { requiresSuperAdmin: true },
            },
            {
                path: 'log-aktivitas',
                name: 'activity-logs',
                component: () => import('@/views/ActivityLogsView.vue'),
                meta: { permission: 'activity-logs.view' },
            },
            {
                path: 'status-server',
                name: 'server-status',
                component: () => import('@/views/ServerStatusView.vue'),
                meta: { requiresSuperAdmin: true },
            },
        ],
    },
    {
        path: '/:pathMatch(.*)*',
        redirect: '/',
    },
]

const router = createRouter({
    history: createWebHistory(),
    routes,
})

// SENGAJA tidak memakai useAuthStore() (Pinia) di sini. pinia@4 + vue-router@5
// kombinasi versi baru ini mengalami "getActivePinia() called but there was
// no active Pinia" yang konsisten gagal pada navigasi AWAL walau
// app.use(pinia) + setActivePinia() sudah dipanggil duluan di main.js --
// kemungkinan guard yang didaftarkan sebelum app manapun ada dieksekusi
// Vue Router lewat jalur runWithContext yang tidak konsisten kaitannya ke
// instance pinia yang sama di kombinasi versi ini. localStorage adalah
// SATU-SATUNYA sumber kebenaran token/user juga di stores/auth.js (lihat
// TOKEN_STORAGE_KEY/USER_STORAGE_KEY di sana) -- baca langsung dari situ di
// guard menghindari seluruh masalah ini sama sekali, tanpa store perlu aktif.
const TOKEN_STORAGE_KEY = 'lacak_master_token'
const USER_STORAGE_KEY = 'lacak_master_user'
export const LOGIN_REDIRECT_KEY = 'lacak_master_login_redirect'

const pageMeta = new Map(routes.find((route) => route.path === '/').children.map((route) => [route.name, route.meta ?? {}]))

/**
 * Boleh membuka halaman dengan meta ini? Satu-satunya aturan akses halaman: dipakai penjaga rute
 * di bawah DAN menu sidebar (AppShell), jadi menu yang tampil selalu bisa dibuka dan sebaliknya.
 * `permission` boleh satu izin atau daftar (cukup salah satu).
 */
export function canEnter(meta, user) {
    const roles = user?.roles ?? []
    const permissions = user?.permissions ?? []
    const isSuperAdmin = roles.includes('super_admin')
    if (meta?.requiresSuperAdmin && !isSuperAdmin) return false
    if (meta?.roles && !meta.roles.some((role) => roles.includes(role))) return false
    if (meta?.staffAccess && !isSuperAdmin && user?.site_scope !== 'granted') return false
    if (meta?.permission && ![meta.permission].flat().some((permission) => permissions.includes(permission))) return false
    return true
}

/** Boleh membuka halaman bernama ini? */
export const canOpen = (name, user) => canEnter(pageMeta.get(name), user)

/** Halaman awal: yang pertama diizinkan. Briefing tanpa syarat izin, jadi selalu ada tujuan. */
function homeFor(user) {
    const name = ['radar', 'live', 'briefing'].find((candidate) => canOpen(candidate, user)) ?? 'briefing'
    return { name }
}

router.beforeEach(async (to) => {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY)
    const isAuthenticated = !!token
    let user = null
    try {
        user = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || 'null')
    } catch {
        user = null
    }

    if (to.meta.requiresAuth && !isAuthenticated) {
        // Halaman tujuan diingat di sessionStorage, bukan ?redirect= di URL,
        // supaya alamat login tetap bersih (/login). Dibaca LoginView.
        if (to.fullPath !== '/') sessionStorage.setItem(LOGIN_REDIRECT_KEY, to.fullPath)
        return { name: 'login' }
    }

    if (to.meta.guestOnly && isAuthenticated) {
        return homeFor(user)
    }

    // Whitelist IP: dari IP yang tidak terdaftar, form login tidak ditampilkan.
    // Backend tidak bisa dihubungi (null) -> login tetap tampil; penolakan
    // sebenarnya tetap terjadi di backend saat login.
    if (to.name === 'login' || to.name === 'ip-restricted') {
        const access = await checkIpAccess()
        if (to.name === 'login' && access?.allowed === false) return { name: 'ip-restricted' }
        if (to.name === 'ip-restricted' && access?.allowed !== false) return { name: 'login' }
    }

    // Halaman yang tidak boleh dibuka -> halaman awal user ini (bukan selalu Radar: peran tanpa izin
    // device akan terpental terus kalau tujuannya juga ditolak).
    if (!canEnter(to.meta, user)) {
        const home = homeFor(user)
        return to.name === home.name ? true : home
    }

    return true
})

export default router
