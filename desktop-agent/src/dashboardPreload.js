'use strict'

/**
 * Preload jendela dashboard: menyuntik sesi (token + user) ke localStorage dashboard
 * SEBELUM skrip halaman berjalan, supaya staf otomatis masuk tanpa login ulang.
 * Kunci harus sama dengan web-dashboard/src/stores/auth.js.
 * Token diteruskan lewat additionalArguments (process.argv), bukan diekspos ke halaman.
 */
try {
    const prefix = '--lacak-session='
    const arg = process.argv.find((a) => a.startsWith(prefix))
    if (arg) {
        const data = JSON.parse(decodeURIComponent(arg.slice(prefix.length)))
        if (data.token) window.localStorage.setItem('lacak_master_token', data.token)
        if (data.user) window.localStorage.setItem('lacak_master_user', JSON.stringify(data.user))
    }
} catch {
    // Kalau gagal, staf tinggal login manual di dashboard.
}
