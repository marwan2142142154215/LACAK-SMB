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

    function setSession(accessToken, userData) {
        token.value = accessToken
        user.value = userData
        localStorage.setItem(TOKEN_STORAGE_KEY, accessToken)
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userData))
    }

    function clearSession() {
        token.value = null
        user.value = null
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
        return response.data.data
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

    return {
        token,
        user,
        isAuthenticated,
        isSuperAdmin,
        hasPermission,
        login,
        confirmTwoFactorSetup,
        verifyTwoFactor,
        logout,
        clearSession,
        refreshProfile,
    }
})
