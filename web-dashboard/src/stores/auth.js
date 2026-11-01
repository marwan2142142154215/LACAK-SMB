import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import api from '@/lib/api'

const TOKEN_STORAGE_KEY = 'lacak_master_token'
const USER_STORAGE_KEY = 'lacak_master_user'

export const useAuthStore = defineStore('auth', () => {
    const token = ref(localStorage.getItem(TOKEN_STORAGE_KEY) || null)
    const user = ref(JSON.parse(localStorage.getItem(USER_STORAGE_KEY) || 'null'))

    const isAuthenticated = computed(() => !!token.value)
    const isSuperAdmin = computed(() => user.value?.roles?.includes('super_admin') ?? false)
    // Peran dengan cakupan "site yang diberikan" (admin, leader, atau peran buatan sendiri): dasar
    // halaman Staf untuk menonaktifkan staf di site yang dipegang.
    const hasSiteGrants = computed(() => user.value?.site_scope === 'granted')
    // Tanpa izin live.roster, di Live Kerja/Aktivitas/Rekaman hanya melihat diri
    // sendiri -- sama dengan aturan di backend (dibatasi juga di sana).
    const seesOnlySelf = computed(() => !(user.value?.permissions?.includes('live.roster') ?? false))

    function setSession(accessToken, userData) {
        token.value = accessToken
        user.value = userData
        localStorage.setItem(TOKEN_STORAGE_KEY, accessToken)
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userData))
    }

    function clearSession() {
        token.value = null
        user.value = null
        profileTask = null
        localStorage.removeItem(TOKEN_STORAGE_KEY)
        localStorage.removeItem(USER_STORAGE_KEY)
    }

    function hasPermission(permission) {
        return user.value?.permissions?.includes(permission) ?? false
    }

    async function login(username, password) {
        const response = await api.post('/auth/login', {
            username,
            password,
            client: 'web_dashboard',
        })
        const data = response.data.data
        // 2FA dimatikan super_admin (Pengaturan): token langsung diberikan
        // tanpa langkah kode authenticator.
        if (data.access_token) setSession(data.access_token, data.user)
        return data
    }

    async function confirmTwoFactorSetup(setupToken, code) {
        const response = await api.post('/auth/2fa/setup/confirm', {
            setup_token: setupToken,
            code,
        })
        const { access_token, user: userData } = response.data.data
        setSession(access_token, userData)
        return response.data.data
    }

    async function verifyTwoFactor(challengeToken, code) {
        const response = await api.post('/auth/2fa/verify', {
            challenge_token: challengeToken,
            code,
        })
        const { access_token, user: userData } = response.data.data
        setSession(access_token, userData)
        return response.data.data
    }

    async function logout() {
        try {
            await api.post('/auth/logout')
        } finally {
            clearSession()
        }
    }

    async function refreshProfile() {
        const response = await api.get('/auth/me')
        user.value = response.data.data
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(response.data.data))
    }

    // Peran, izin, cakupan site & hak tonton bisa diubah admin kapan saja (menu Peran) --
    // salinan yang disimpan saat login jadi basi dan menyembunyikan menu/fitur yang
    // sebenarnya sudah diizinkan server. Dimuat ulang sekali per pemuatan halaman, lalu
    // paling sering tiap PROFILE_REFRESH_MS. /auth/session: data sama dengan /auth/me
    // tapi tidak memperpanjang batas idle login.
    const PROFILE_REFRESH_MS = 5 * 60_000
    let profileTask = null
    let profileLoadedAt = 0

    function ensureFreshProfile() {
        if (!token.value) return Promise.resolve()
        if (profileTask && Date.now() - profileLoadedAt < PROFILE_REFRESH_MS) return profileTask
        profileLoadedAt = Date.now()
        profileTask = api
            .get('/auth/session')
            .then((response) => {
                user.value = response.data.data
                localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(response.data.data))
            })
            // Gagal (jaringan, sesi habis -> interceptor yang menangani): tetap pakai salinan lama.
            .catch(() => {})
        return profileTask
    }

    return {
        token,
        user,
        isAuthenticated,
        isSuperAdmin,
        hasSiteGrants,
        seesOnlySelf,
        hasPermission,
        login,
        confirmTwoFactorSetup,
        verifyTwoFactor,
        logout,
        clearSession,
        refreshProfile,
        ensureFreshProfile,
    }
})
