/*
 * Penunjuk ke router untuk kode di luar komponen (store, interceptor). Diisi sekali oleh main.js.
 * Dipakai supaya store tidak perlu `import('@/router')` -- impor dinamis modul yang juga diimpor
 * statis tidak memecah bundle dan memunculkan peringatan build.
 */
let current = null

export const setRouter = (router) => {
    current = router
}

/** Pindah ke halaman login; kalau router belum terpasang, muat ulang ke /login. */
export function goToLogin() {
    if (current) current.push({ name: 'login' })
    else window.location.assign('/login')
}
