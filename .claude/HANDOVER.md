# Project Handover

## Tujuan
LACAK-SMB: sistem pelacakan perangkat & manajemen kerja staf (lokasi GPS/BLE/WiFi, geofence, lock/unlock jarak jauh, absensi, briefing & Live Kerja via LiveKit, chat, peringatan, Telegram). Monorepo: 3 proyek AdonisJS (`backend-adonis` API, `realtime-gateway` Socket.IO, `telegram-bot`), `web-dashboard` (Vue 3), 3 APK Android (Kotlin/Compose), agen Windows & server-gui (Python), `livekit-server` (Docker). Aktif sekarang: menaikkan ke produksi di `https://lacaklive.smbservice.xyz` (satu server, satu domain, pm2 + nginx).

## Kondisi Saat Ini
- Produksi di server `lacak-live` (user `smbapps`, repo di `~/lacaklive`): backend (port 7564), queue, scheduler, gateway (3333) berjalan lewat pm2 dan sehat. Dashboard di-build lalu disalin ke `/var/www/lacaklive/dashboard`; nginx pakai `/etc/nginx/sites-available/100-lacaklive` (contoh: `deploy/nginx/lacaklive.conf.example`).
- Database `lacaklive` sudah dimigrasi (`node ace migration:run`) dan di-seed; `.env` tiap proyek diisi manual oleh pemilik (jangan diminta/ditulis ke chat).
- Semua file disimpan di DigitalOcean Spaces, bucket `chatusnow`, folder `lacaklive/` (`DO_SPACES_PREFIX`); tidak ada penyimpanan lokal.
- Perubahan lokal (rename, migration, Storage, nginx, ecosystem) per terakhir dicek sudah di-commit oleh pemilik (working tree bersih).

## Sudah Selesai
- Rename file `app/**`, `commands/`, `providers/`, `database/accounts|schema_rules|seeders` di 3 proyek AdonisJS ke PascalCase (mis. `AuthMiddleware.ts`); semua import ikut. `config/`, `bin/`, `start/`, `tests/`, `index.ts`, nama migration sengaja TIDAK diubah. ESLint `@unicorn/filename-case` diizinkan PascalCase + snake_case.
- Migration digabung: kolom `face_missing`, `invited_user_ids`, `consent_document_id` nullable, `last_ssid` masuk `database/schema/baseline.sql`; grant izin admin/leader dihapus (sumber kebenaran: `seedRolesAndPermissions` di `Accounts.ts`). Tersisa: 0000, 0004, 0005, 0007.
- Penyimpanan Spaces diberi awalan folder (`spacesKey`/`stripSpacesPrefix` di `app/services/Storage.ts`), termasuk rekaman Egress LiveKit; ada unit test.
- `ecosystem.config.cjs` (pm2, menjalankan hasil `build/`): lacak-api, -queue, -scheduler, lacak-gateway, lacak-bot.
- Verifikasi: tsc bersih di 3 proyek, eslint bersih (backend, gateway), unit test backend 128/128, migration lolos di Postgres produksi.

## Keputusan Penting
- Satu domain: `/` dashboard statis, `/api/` ke backend, `/socket.io/` ke gateway (path Socket.IO bawaan; JANGAN pakai prefix `/gateway/`). LiveKit disarankan subdomain sendiri `live.smbservice.xyz`; UDP 7882-7889 & TCP 7881 harus terbuka langsung di firewall.
- `LARAVEL_APP_KEY` (format `base64:` + 32 byte) & `LARAVEL_APP_URL` tetap bernama itu (kompatibilitas tanda tangan URL & 2FA); jangan diganti setelah dipakai.
- `LACAKSMB_PUBLIC_GATEWAY_URL` / `LACAKSMB_PUBLIC_BACKEND_API_URL` wajib diisi domain baru, kalau tidak APK hasil build menunjuk `ws/api.salahmu.fun`.
- Dashboard: nilai `VITE_*` ditanam saat build; di server pakai `web-dashboard/.env.production.local` (menimpa `.env.production` yang masih berisi salahmu.fun).
- Bucket Spaces privat; unduhan lewat tautan bertanda waktu 5 menit.

## Masih Bermasalah / Perlu Dicek
- `lacak-bot` gagal start: `APP_KEY` di `telegram-bot/.env` kosong; isi juga `TELEGRAM_BOT_TOKEN`, `BACKEND_API_URL=http://127.0.0.1:7564/api/v1`, `BACKEND_API_TOKEN` (`node ace bot:issue-telegram-token` di backend). Atau `pm2 stop lacak-bot` bila belum dipakai.
- Belum diuji end-to-end: login+2FA di dashboard, data realtime (`/socket.io/`), upload gambar chat ke `lacaklive/chat/`, Live Kerja/LiveKit (belum diputuskan `LIVEKIT_URL` subdomain atau domain utama), nama file `egress_ended` dari LiveKit (kode menangani dengan/tanpa awalan).
- Functional test backend & unit test gateway belum pernah dijalankan (butuh Postgres test role `lacak_app` + env gateway).
- `pm2 save && pm2 startup` belum dikonfirmasi; `LACAKSMB_STATUS_SYSTEMD_UNITS` tidak relevan (pakai pm2) sehingga Status server bisa tampak mati.
- Masih berisi domain lama `salahmu.fun`: `web-dashboard/.env.production`, `windows-tracked-agent/config.example.json`, `deploy/chrome-kantor/*.reg`, `livekit-server/*.example`, `docs/`.
- Rahasia pernah terlihat di chat (mis. `LIVEKIT_API_SECRET`): sebaiknya dirotasi; password super admin dari seed dicetak sekali.
- Build APK dari dashboard butuh JDK/Android SDK + `LACAKSMB_*_PROJECT_PATH` di server; belum disiapkan.

## Next Action
1. Selesaikan `telegram-bot/.env` lalu `pm2 restart lacak-bot` (atau stop), jalankan `pm2 save && pm2 startup`.
2. Uji alur utama dari browser: login+2FA, radar realtime, upload gambar chat.
3. Putuskan LiveKit (subdomain + `docker compose up`, firewall UDP) dan isi `LIVEKIT_*` sama dengan `livekit.yaml`.
4. Ganti domain lama di file yang tersisa (lihat daftar di atas); rotasi rahasia yang bocor.
5. Siapkan DB/role test untuk menjalankan `node ace test functional`.

## Jangan Lakukan
- Jangan commit/push atas nama pemilik (aturan Git global); jangan menulis atau meminta nilai rahasia `.env` di chat.
- Jangan mengganti nama/menghapus migration yang sudah jalan di DB produksi (tercatat di `adonis_schema`); perubahan skema baru = migration Lucid baru.
- Jangan ganti `LARAVEL_APP_KEY` / `APP_KEY` setelah dipakai (2FA & URL bertanda tangan jadi tidak valid).
- Jangan simpan file di disk server (semua ke Spaces); jangan pakai prefix `/gateway/` di nginx; jangan pasang CSP ketat tanpa Report-Only dulu.
- Jangan tambah `add_header` di dalam `location` nginx tanpa mengulang header keamanan (menimpa header level server).

## Catatan Penting
- Menjalankan lokal: `npm ci`, lalu `node ace serve --hmr` (dev) / `node ace build` (produksi). Produksi: `cp .env build/.env && cd build && npm ci --omit=dev`, dijalankan pm2 dari `ecosystem.config.cjs`.
- Dokumentasi: `docs/rencana-migrasi-adonis.md` (migrasi Laravel→Adonis, selesai), `docs/skema-database.md`, `docs/kontrak-status-perangkat.md`.
- `git mv` dipakai untuk rename (beda huruf besar-kecil di Windows); server Linux case-sensitive, import sudah dicek 494/494 cocok persis.
- Skill audit keamanan Cloudflare di `D:\TOOLS\security-audit-skill` dinilai aman dipasang, belum dipasang; berat (banyak agen), pakai profil `quick`.
