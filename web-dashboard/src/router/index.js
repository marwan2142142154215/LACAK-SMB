import { createRouter, createWebHistory } from 'vue-router'

const routes = [
    {
        path: '/login',
        name: 'login',
        component: () => import('@/views/LoginView.vue'),
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
                path: 'consent-documents',
                name: 'consent-documents',
                component: () => import('@/views/ConsentDocumentsView.vue'),
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

router.beforeEach((to) => {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY)
    const isAuthenticated = !!token
    let isSuperAdmin = false
    try {
        const user = JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || 'null')
        isSuperAdmin = user?.roles?.includes('super_admin') ?? false
    } catch {
        isSuperAdmin = false
    }

    if (to.meta.requiresAuth && !isAuthenticated) {
        return { name: 'login', query: { redirect: to.fullPath } }
    }

    if (to.meta.guestOnly && isAuthenticated) {
        return { name: 'radar' }
    }

    if (to.meta.requiresSuperAdmin && !isSuperAdmin) {
        return { name: 'radar' }
    }

    return true
})

export default router
