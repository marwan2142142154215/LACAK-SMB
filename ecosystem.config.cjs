/**
 * PM2 untuk Lacak SMB: menjalankan HASIL BUILD (`node ace build`) tiap proyek
 * AdonisJS. Padanan dari unit systemd di backend-adonis/deploy/*.service.
 *
 * Persiapan (sekali, dan setiap rilis):
 *   for p in backend-adonis realtime-gateway telegram-bot; do
 *     (cd $p && npm ci && node ace build && cp .env build/.env \
 *        && (cd build && npm ci --omit=dev))
 *   done
 *
 * Jalankan:
 *   pm2 start ecosystem.config.cjs            # semua
 *   pm2 start ecosystem.config.cjs --only lacak-api
 *   pm2 reload ecosystem.config.cjs           # restart tanpa putus
 *   pm2 save && pm2 startup                   # hidup lagi setelah reboot
 *
 * Catatan: jalankan SATU instance saja per proses (fork). Gateway menyimpan
 * status realtime di memori, dan queue/scheduler tidak boleh ganda.
 */
const path = require('node:path')

const dir = (name) => path.join(__dirname, name, 'build')

/** Pengaturan bersama: batas restart meniru StartLimit systemd (5x / 5 menit). */
const base = {
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    min_uptime: '10s',
    max_restarts: 5,
    restart_delay: 5000,
    time: true,
    merge_logs: true,
    env: { NODE_ENV: 'production' },
}

module.exports = {
    apps: [
        {
            ...base,
            name: 'lacak-api',
            cwd: dir('backend-adonis'),
            script: 'bin/server.js',
            // Aplikasi keluar sendiri setelah 8 detik (bin/server.ts).
            kill_timeout: 15000,
        },
        {
            ...base,
            name: 'lacak-api-queue',
            cwd: dir('backend-adonis'),
            script: 'ace.js',
            args: 'queue:work',
            // Build APK bisa sampai ~5 menit; worker menunggu job selesai.
            kill_timeout: 330000,
        },
        {
            ...base,
            name: 'lacak-api-scheduler',
            cwd: dir('backend-adonis'),
            script: 'ace.js',
            args: 'scheduler:run',
            kill_timeout: 30000,
        },
        {
            ...base,
            name: 'lacak-gateway',
            cwd: dir('realtime-gateway'),
            script: 'bin/server.js',
            kill_timeout: 15000,
        },
        {
            ...base,
            name: 'lacak-bot',
            cwd: dir('telegram-bot'),
            script: 'ace.js',
            args: 'bot:run',
            kill_timeout: 10000,
        },
    ],
}
