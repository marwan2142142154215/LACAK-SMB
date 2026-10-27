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
            },
            {
                path: 'live',
                name: 'live',
                component: () => import('@/views/LiveView.vue'),
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
            },
            {
                path: 'aktivitas',
                name: 'activity',
                component: () => import('@/views/ActivityView.vue'),
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
            },
            {
                path: 'staff',
                name: 'staff',
                component: () => import('@/views/StaffView.vue'),
                // Admin & leader: hanya menonaktifkan / mengaktifkan staf di site-nya.
                meta: { roles: ['super_admin', 'admin', 'leader'] },
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

router.beforeEach(async (to) => {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY)
    const isAuthenticated = !!token
    let isSuperAdmin = false
    let permissions = []
    let roles = []
    try {
        const user = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || 'null')
        isSuperAdmin = user?.roles?.includes('super_admin') ?? false
        permissions = user?.permissions ?? []
        roles = user?.roles ?? []
    } catch {
        isSuperAdmin = false
    }

    if (to.meta.requiresAuth && !isAuthenticated) {
        // Halaman tujuan diingat di sessionStorage, bukan ?redirect= di URL,
        // supaya alamat login tetap bersih (/login). Dibaca LoginView.
        if (to.fullPath !== '/') sessionStorage.setItem(LOGIN_REDIRECT_KEY, to.fullPath)
        return { name: 'login' }
    }

    if (to.meta.guestOnly && isAuthenticated) {
        return { name: 'radar' }
    }

    // Whitelist IP: dari IP yang tidak terdaftar, form login tidak ditampilkan.
    // Backend tidak bisa dihubungi (null) -> login tetap tampil; penolakan
    // sebenarnya tetap terjadi di backend saat login.
    if (to.name === 'login' || to.name === 'ip-restricted') {
        const access = await checkIpAccess()
        if (to.name === 'login' && access?.allowed === false) return { name: 'ip-restricted' }
        if (to.name === 'ip-restricted' && access?.allowed !== false) return { name: 'login' }
    }

    if (to.meta.requiresSuperAdmin && !isSuperAdmin) {
        return { name: 'radar' }
    }

    if (to.meta.roles && !to.meta.roles.some((role) => roles.includes(role))) {
        return { name: 'radar' }
    }

    if (to.meta.permission && !permissions.includes(to.meta.permission)) {
        return { name: 'radar' }
    }

    return true
})

export default router
