import * as Sentry from '@sentry/vue'
import dayjs from 'dayjs'
import 'dayjs/locale/id'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from '@/App.vue'
import api from '@/lib/api'
import { forgetIpAccess } from '@/lib/ipAccess'
import router from '@/router'
import { useToast } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'
import { useLiveStore } from '@/stores/live'

import './style.css'

// Nama hari/bulan & "x menit yang lalu" dalam Bahasa Indonesia di seluruh dashboard
dayjs.locale('id')

const app = createApp(App)
const pinia = createPinia()

// Standar 1.7: Sentry wajib dipasang di production. SENGAJA no-op kalau
// VITE_SENTRY_DSN belum diisi (belum daftar akun Sentry) -- supaya tidak
// bikin app gagal start di dev/staging sebelum DSN tersedia. Isi
// VITE_SENTRY_DSN di .env begitu DSN dari sentry.io sudah ada.
if (import.meta.env.VITE_SENTRY_DSN) {
    Sentry.init({
        app,
        dsn: import.meta.env.VITE_SENTRY_DSN,
        environment: import.meta.env.MODE,
    })
}

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
            // Token tidak berlaku lagi -> siaran Live Kerja di tab ini ikut
            // berhenti, jangan terus menyiarkan tanpa akun yang login.
            useLiveStore(pinia)
                .disconnect()
                .catch(() => {})
            // Satu akun = satu sesi: login di perangkat lain mengakhiri sesi ini.
            if (error.response.data?.errors?.reason === 'session_replaced') {
                useToast().error('Anda telah keluar', error.response.data.message)
            }
            router.push({ name: 'login' })
        }
        // Whitelist IP: jaringan ini tidak terdaftar -> keluar ke halaman
        // "Akses dibatasi" (yang sudah menjelaskan sendiri, tanpa toast).
        if (error.response?.status === 403 && error.response.data?.errors?.reason === 'ip_not_allowed') {
            if (auth.isAuthenticated) {
                auth.clearSession()
                useLiveStore(pinia)
                    .disconnect()
                    .catch(() => {})
            }
            forgetIpAccess()
            router.push({ name: 'ip-restricted' })
        }
        return Promise.reject(error)
    },
)

app.mount('#app')

// PWA: wajib ada service worker terdaftar supaya browser menawarkan
// "Install aplikasi" (lihat public/sw.js -- tidak meng-cache apa pun).
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
}
