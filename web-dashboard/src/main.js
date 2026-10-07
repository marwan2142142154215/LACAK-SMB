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

// Interceptor di sini (bukan di lib/api.js) karena butuh akses ke Pinia
// store, yang baru tersedia setelah app.use(pinia) dipanggil.
const auth = useAuthStore()

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
