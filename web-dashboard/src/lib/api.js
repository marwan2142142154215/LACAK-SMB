import axios from 'axios'

import { createApiAdapter, createPageScope } from '@/lib/apiCache'

/**
 * Satu-satunya cara aplikasi ini bicara ke backend-api (standar 1.4: Axios,
 * bukan fetch mentah, supaya penanganan error seragam). Token Bearer
 * ditambahkan otomatis lewat interceptor dari auth store.
 */
const api = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL,
    headers: {
        Accept: 'application/json',
    },
})

/** Dibatalkan oleh router saat pindah menu (lihat router/index.js). */
export const pageScope = createPageScope()

// Cache GET singkat + pembatalan permintaan halaman yang ditinggalkan (lihat lib/apiCache.js).
api.defaults.adapter = createApiAdapter(axios.getAdapter(api.defaults.adapter), { pageScope })

export default api
