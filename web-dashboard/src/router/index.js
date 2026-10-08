import { createRouter, createWebHistory } from 'vue-router'

import { useAuthStore } from '@/stores/auth'

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

router.beforeEach((to) => {
    const auth = useAuthStore()

    if (to.meta.requiresAuth && !auth.isAuthenticated) {
        return { name: 'login', query: { redirect: to.fullPath } }
    }

    if (to.meta.guestOnly && auth.isAuthenticated) {
        return { name: 'radar' }
    }

    if (to.meta.requiresSuperAdmin && !auth.isSuperAdmin) {
        return { name: 'radar' }
    }

    return true
})

export default router
