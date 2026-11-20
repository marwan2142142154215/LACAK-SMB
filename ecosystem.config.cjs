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
 * Catatan: gateway, queue, dan scheduler SATU instance saja (gateway menyimpan status realtime di memori,
 * queue/scheduler tidak boleh ganda). Hanya API HTTP yang boleh punya salinan (lihat API_REPLICAS).
 */
const path = require('node:path')

const fs = require('node:fs')

const dir = (name) => path.join(__dirname, name, 'build')

// Rekorder ringan (folder recorder/, Go) hanya ikut dijalankan kalau binary-nya sudah dibangun di server:
//   cd recorder && go build -o lacak-recorder .
const recorderBinary = path.join(__dirname, 'recorder', 'lacak-recorder')

/** Salinan lacak-api (selain yang di PORT dari .env, bawaan 7564), masing-masing satu proses di port sendiri. */
const API_REPLICAS = [
    { name: 'lacak-api-2', port: 7565 },
    { name: 'lacak-api-3', port: 7566 },
]

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
        // Salinan API di port lain: satu proses Node hanya memakai satu core, dan API ini tanpa status per
        // proses (rate limit di Redis, cache lokal ber-TTL pendek). Nginx membagi permintaan ke semua port
        // (upstream lacak_api). Daftarkan hanya yang dipakai di upstream nginx.
        ...API_REPLICAS.map(({ name, port }) => ({
            ...base,
            name,
            cwd: dir('backend-adonis'),
            script: 'bin/server.js',
            kill_timeout: 15000,
            env: { ...base.env, PORT: String(port) },
        })),
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
        // Perekam Live Kerja tanpa Docker: menulis track VP8 staf ke WebM lalu mengunggah ke Spaces.
        // Membaca key LiveKit dari .env backend. Berhenti dengan menyelesaikan berkas yang sedang berjalan.
        ...(fs.existsSync(recorderBinary)
            ? [
                  {
                      ...base,
                      name: 'lacak-recorder',
                      cwd: path.join(__dirname, 'recorder'),
                      script: recorderBinary,
                      interpreter: 'none',
                      args: '-env ../backend-adonis/.env',
                      kill_timeout: 100000,
                  },
              ]
            : []),
    ],
}
