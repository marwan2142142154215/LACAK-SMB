import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from '@/App.vue'
import api from '@/lib/api'
import router from '@/router'
import { useAuthStore } from '@/stores/auth'

import './style.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// useAuthStore(pinia) -- instance pinia dioper EKSPLISIT, bukan
// useAuthStore() biasa. Dipanggil di sini, di luar context component Vue
// manapun (cuma lewat setup()/computed component biasanya "tahu" pinia aktif
// yang mana secara otomatis) -- tanpa argumen ini gagal dengan
// "getActivePinia() called but there was no active Pinia" di kombinasi
// pinia@4 + vue-router@5 yang dipakai proyek ini, walau app.use(pinia) sudah
// dipanggil duluan. Ini pola resmi Pinia untuk pemakaian di luar component,
// lihat https://pinia.vuejs.org/core-concepts/outside-component-usage.html
const auth = useAuthStore(pinia)

api.interceptors.request.use((config) => {
    if (auth.token) {
        config.headers.Authorization = `Bearer ${auth.token}`
    }
    return config
})

api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401 && auth.isAuthenticated) {
            auth.clearSession()
            router.push({ name: 'login' })
        }
        return Promise.reject(error)
    },
)

app.mount('#app')
