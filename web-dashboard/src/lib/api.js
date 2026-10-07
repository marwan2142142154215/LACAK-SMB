import axios from 'axios'

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

export default api
