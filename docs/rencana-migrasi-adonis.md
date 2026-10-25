# Rencana migrasi backend-api (Laravel) ke AdonisJS

Status: **rencana, belum dikerjakan.** Disusun 25 Okt 2026 dari kode `backend-api` di commit `7ac7956`.

## Ringkasnya

- Backend ditulis ulang ke **AdonisJS 7**, versi yang sama dengan `realtime-gateway` (core 7.5, Lucid 22, Auth 10, VineJS 4).
- Database Postgres yang sekarang **tetap dipakai apa adanya**: tidak ada pindah data, tabel lama tidak diganti nama.
- Kontrak API dipertahankan persis: URL, bentuk respons `{success, message, data, errors}`, kode status, dan format token. Dashboard, APK Master, APK Live, dan gateway **tidak perlu diubah**, dan tidak ada yang harus login ulang.
- Migrasi dilakukan **bertahap per modul** (pola *strangler*). Nginx mengarahkan path yang sudah dipindah ke Adonis dan sisanya tetap ke Laravel. Setiap tahap bisa dibatalkan dengan mengembalikan satu baris konfigurasi nginx.
- Perkiraan untuk 1 developer: **4–6 minggu kerja**, termasuk porting tes. Angka ini perkiraan kasar dari ukuran kode, bukan hasil pengukuran.

**Catatan jujur soal performa.** Dari data htop dan nginx (25 Okt), beban server terutama datang dari LiveKit, flood `/live/overview`, dan bot Telegram yang restart berulang. PHP-nya sendiri bukan penyebab utama. Ketiga masalah itu sudah diperbaiki di Laravel. Adonis (satu proses Node, tanpa bootstrap ulang per request) memang lebih hemat untuk endpoint kecil yang sering dipanggil seperti heartbeat dan overview, tapi alasan utama migrasi sebaiknya kesamaan stack dengan gateway dan bot, bukan semata performa.

## Ukuran yang dipindahkan

| Bagian | Jumlah |
|---|---|
| Endpoint API (`/api/v1`) | 73 |
| Controller | 19 |
| Model | 16 |
| Migrasi skema | 42 |
| Service (`app/Services`, `app/Support`) | 9 |
| Middleware khusus | 2 (`ExtendTokenExpiry`, `RecordApiActivity`) |
| Job antrean | 2 (`BuildApkJob`, `RecordQueueHeartbeat`) |
| Command artisan + jadwal | 3 command, 2 tugas terjadwal |
| File tes fitur | 13 |
| Baris PHP di `app/` | ±6.400 |

## Padanan Laravel → Adonis

| Laravel | Adonis | Catatan |
|---|---|---|
| Eloquent | Lucid | `realtime-gateway` sudah punya 9 model Lucid di DB yang sama; disatukan jadi satu paket model. |
| FormRequest / `validate()` | VineJS | Pesan error divalidasi ulang supaya tetap `errors.{field}` seperti sekarang. |
| Sanctum (`id\|token`, sha256) | **Guard kustom** | Format token Adonis (`oat_…`) berbeda. Guard kustom membaca `personal_access_tokens` dan mencocokkan sha256 seperti Sanctum, jadi token yang sedang dipakai tetap berlaku. |
| `ExtendTokenExpiry` | Middleware | Idle timeout 2 jam, token layanan (`expires_at` null) tidak disentuh. |
| Password bcrypt `$2y$` | `bcryptjs` | Hash driver bawaan Adonis memakai format PHC, jadi verifikasi `$2y$` ditulis sendiri. Hash baru tetap `$2y$` selama Laravel masih hidup. |
| `Crypt::encryptString` (2FA secret, recovery code) | Implementasi kompatibel | AES-256-CBC + MAC, payload JSON base64 dengan `APP_KEY` yang sama. Wajib dijaga test vektor dari data Laravel asli. |
| google2fa + bacon QR | `otplib` + `qrcode` | Jendela ±2 periode dan anti-replay dipertahankan. |
| spatie/laravel-permission | Service permission sendiri | Membaca tabel `roles`, `permissions`, `model_has_roles`, `role_has_permissions` yang sama. |
| spatie/laravel-activitylog + `RecordApiActivity` | Middleware + writer sendiri | Menulis ke `activity_log` dengan kolom dan format `properties` yang sama, karena menu Log aktivitas membacanya. |
| Signed URL (`signed` middleware) | Signer kompatibel | Unduhan APK, dokumen consent, dan gambar chat memakai URL bertanda tangan HMAC `APP_KEY`. Signer Adonis harus menghasilkan dan memeriksa tanda tangan yang sama selama dua backend hidup berdampingan. |
| Flysystem (local + DigitalOcean Spaces) | `@adonisjs/drive` (FlyDrive) | Disk `documents` dan `chat_images`. |
| Queue database (`BuildApkJob`) | Worker antrean | Pilihan: `@rlanz/bull-queue` (Redis, sudah ada di server) atau worker yang membaca tabel `jobs`. Build APK bergantung pada path Windows (`server_exe_path`), perlu dicek ulang di mana build sebenarnya dijalankan. |
| Scheduler (`CloseStaleWorkSessions`, detak scheduler) | Command `node ace` + systemd timer | Adonis tidak punya scheduler bawaan. |
| Rate limit (`throttle:…`) | `@adonisjs/limiter` (Redis) | Heartbeat 60/menit, login 5 percobaan. |
| Cache (`CACHE_STORE`) | Redis | Cache overview 5 detik dan penanda `session_replaced`. |
| Sentry Laravel | `@sentry/node` | |
| Pest | Japa (`@japa/api-client`) | 13 file tes diporting dan jalan di database tes yang sama. |
| Migrasi skema | Lucid migrations | Skema saat ini dijadikan satu migrasi *baseline* yang dilewati di database yang sudah ada. Migrasi baru sesudahnya hanya di Adonis. |

Paket `barryvdh/laravel-dompdf` dan `maatwebsite/excel` ada di `composer.json` tapi tidak dipakai di `app/`, jadi tidak perlu dipindahkan.

## Tahapan

### Tahap 0 — Fondasi (±1 minggu)

- [x] Aplikasi Adonis baru `backend-adonis/`, dengan versi paket disamakan dengan `realtime-gateway`. Proses dipaksa UTC, dan BIGINT di-parse sebagai number.
- [x] Koneksi Postgres dan Redis yang sama (`config/redis.ts`: koneksi `main` untuk cache dan `queue` untuk antrean).
- [ ] Model Lucid untuk 16 tabel (baru `users` dan `personal_access_tokens`; gabungkan dengan model gateway).
- [x] Lapisan kompatibilitas Laravel (`app/services/laravel/`): token Sanctum, bcrypt `$2y$`, `Crypt` AES-256-CBC, URL bertanda tangan. Dijaga test vektor dari Laravel asli (`tests/unit/laravel_compat.spec.ts`).
- [x] Middleware `auth` (padanan `auth:sanctum`, termasuk `last_used_at`) dan `extendToken` (idle timeout 2 jam).
- [x] Bentuk respons dan handler error (401, 403, 404, 422 VineJS, 500) dengan pesan yang sama.
- [ ] Alasan `session_replaced` pada 401: penandanya masih di cache Laravel; pindah ke Redis bersama di Tahap 2.
- [x] Service permission (tabel spatie). Endpoint pertama: `/auth/me` dan `/auth/session`.
- [x] Cakupan site (`app/services/organization_scope.ts`) dan writer log aktivitas (`app/services/activity_log.ts`). Cabang `telegram_bot_service` (site dari header `X-Telegram-Chat-Id`) sengaja tidak di-port karena bot Telegram tidak dipakai.
- [x] Harness tes Japa (`tests/bootstrap.ts`, `.env.test` ke `lacak_master_test`).
- [ ] Nginx: upstream kedua dan aturan per path, awalnya belum ada path yang diarahkan.

### Tahap 1 — Endpoint Live Kerja yang paling sering dipanggil (±4 hari)

Status (25 Okt): **kode selesai, belum diuji dengan database, belum dilayani nginx.**

- [x] Status realtime (heartbeat & push status) dipindah ke `realtime-gateway` lewat socket (commit `8dfa294`), bukan ke backend-adonis.
- [x] `backend-adonis`: `/live/sites`, `/live/overview` (cache Redis 5 detik), `/live/sessions` (index, start, heartbeat, end), `/live/app`, `/live/activity`, `/live/watch-token`, `/dashboard-summary`.
- [x] Token LiveKit identik byte per byte dengan Laravel (test vector), aturan status, ringkasan jam kerja, dan cakupan site diuji tes unit.
- [x] Log aktivitas sesi kerja (`created`/`updated` WorkSession) ditulis dengan format spatie yang sama.
- [ ] Tes fungsional terhadap database `lacak_master_test`.
- [x] Rate limit (`throttle:10,1` start, `throttle:60,1` heartbeat, `throttle:30,1` watch-token) lewat `app/middleware/throttle_middleware.ts` (Redis). Kuncinya per user/IP tanpa route, sama dengan `ThrottleRequests` Laravel, jadi semua route ber-throttle berbagi satu penghitung.
- [ ] Nginx mengarahkan path di atas ke `backend-adonis`.

Catatan perbedaan kecil yang tidak mengubah perilaku dashboard: tanggal dikirim sebagai `...000Z` (milidetik) bukan `...000000Z` (mikrodetik), dan objek kosong `devices_by_status` dikirim `{}` bukan `[]`.

`/live/overview`, `/live/sites`, `/live/activity`, `/live/sessions` (index, start, heartbeat, end), `/live/watch-token`, `/live/app`, `/dashboard-summary`, `/auth/me`, `/auth/session`.

Termasuk `WorkPresence` (status dan log kerja), `LiveKitTokenIssuer` (`livekit-server-sdk`), dan cache overview. Ini tahap dengan dampak beban terbesar, jadi dikerjakan paling awal.

### Tahap 2 — Auth (±4 hari)

Login (password lokal dan Account Center, termasuk `AesCbc256` dengan test vektor yang sudah ada), 2FA (setup, verify, recovery code), logout, satu akun satu sesi, `device_type`, rate limit login, dan log aktivitas login.

- [x] `POST /auth/login` (password lokal + Account Center, `AesCbc256` dengan test vektor), `/auth/2fa/setup/confirm`, `/auth/2fa/verify` (TOTP ±2 window, anti-replay, recovery code sekali pakai, 5 percobaan -> 429), `/auth/logout` (menutup sesi kerja). Satu akun satu sesi + `session_replaced`, `device_type`, `TwoFactorPolicy` (`app_settings`). Tes unit lulus.
- [x] Log aktivitas API (`RecordApiActivity`) terpasang global di `start/kernel.ts` (`router.use`, setelah bodyparser), termasuk login/2FA publik.
- [ ] Tes fungsional (`tests/functional/auth_login.spec.ts`) belum dijalankan: DB tes tidak bisa dihubungi.
- [ ] Tanda `session_replaced`, token setup/challenge 2FA, dan anti-replay ada di Redis Adonis, BUKAN di cache Laravel (tabel `cache`). Selama dua backend hidup, semua path `/api/v1/auth/*` harus dialihkan nginx bersamaan; token yang dicabut oleh login di backend lain hanya mendapat 401 biasa.

### Tahap 3 — Modul admin (±1,5 minggu)

| Modul | Endpoint |
|---|---|
| Staf | `users` (CRUD, suspend, reactivate, reset 2FA, akses site) |
| Site & pengaturan | `organizations`, `settings/security`, `system/status` |
| Device | `devices`, perintah, OTP, enrollment, `violations` |
| Aturan | `geofence-rules`, `consent-documents` (upload, unduh, cabut) |
| Telegram | `telegram-bindings`, `telegram-user-links` (beserta lookup) |
| Chat | `chat/messages` (termasuk gambar dan balasan) |
| Log | `activity-logs` |

- [x] Semua route Tahap 3 ada di Adonis dengan method, path, dan nama parameter yang sama (dibandingkan otomatis dengan `php artisan route:list --path=api --json`: 73 route Laravel, 0 hilang). Middleware auth/extendToken/throttle/signed juga sama.
- [x] Controller: `users`, `organizations`, `settings/security`, `system/status`, `devices` (+ perintah, OTP, enrollment, violations), `geofence-rules`, `consent-documents` (upload, unduh bertanda tangan, cabut), `telegram-bindings`, `telegram-user-links` (+ lookup), `chat/messages` (+ gambar, balasan), `activity-logs`. Pesan validasi = bawaan Laravel (locale `en`).
- [x] Tautan Spaces bertanda waktu (`temporaryUrl()`) sekarang di `app/services/storage.ts`; consent, APK, dan gambar chat memakai `app/services/documents.ts`.
- [x] Tes unit lulus (`node ace test unit`). Server boot dan menjawab 401/404 dengan amplop yang sama.
- [ ] Tes fungsional (`tests/functional/{users,devices,rules,chat_logs}_*.spec.ts`) belum dijalankan: DB tes tidak bisa dihubungi. Belum ada uji end-to-end dari dashboard/APK.
- [ ] Perbedaan kecil yang diketahui: id route bukan angka -> 404 (Laravel 500); `per_page` negatif -> 15 (Laravel 500); Vine hanya memberi satu pesan per field (Laravel bisa beberapa); `Str::slug`/`Str::ascii` didekati dengan NFKD; status server menyebut Node/AdonisJS dan driver redis.

### Tahap 4 — Latar belakang (±3 hari)

Build APK lewat antrean, `CloseStaleWorkSessions` dan detak scheduler lewat systemd timer, command `bot:issue-telegram-token` dan pengaturan 2FA, serta unit systemd baru (`lacak-api`, `lacak-api-worker`).

- [x] `apk-builds` (index, upload, generate -> 202, show, destroy, unduh bertanda tangan) + job `build-apk` di BullMQ (`app/jobs/build_apk_job.ts`, `node ace queue:work`, concurrency 1).
- [x] `node ace scheduler:run` (tiap menit: `work-sessions:close-stale`, detak scheduler, job detak antrean), `bot:issue-telegram-token`, `security:two-factor [on|off]`.
- [x] Status server menghitung antrean dari BullMQ + sisa tabel `jobs`/`failed_jobs` Laravel; detak dibaca dari Redis Adonis.
- [x] Batas multipart bodyparser dinaikkan ke 210 MB (unggah APK `max:204800` KB tetap dijawab 422, bukan 413). Cek juga `client_max_body_size` nginx.
- [ ] Tes fungsional (`tests/functional/apk_builds_zero_touch.spec.ts`) belum dijalankan (butuh DB tes dan Redis). Build Gradle/WSL belum diuji nyata.
- [ ] Unit systemd baru belum dibuat: `node build/ace.js queue:work` (worker) dan `node build/ace.js scheduler:run` (scheduler). Jangan jalankan berdampingan dengan `schedule:work` Laravel; job lama di tabel `jobs` harus dihabiskan worker Laravel dulu.
- [ ] Halaman Status server Laravel akan menganggap scheduler/antrean mati begitu hanya proses Adonis yang jalan (detak di Redis, bukan cache database Laravel).

### Tahap 5 — Peralihan penuh (±1 minggu)

- [ ] Semua path diarahkan ke Adonis; Laravel tetap hidup tapi tidak menerima trafik, selama sekitar satu minggu.
- [ ] Halaman Status server dan `LACAKSMB_STATUS_SYSTEMD_UNITS` disesuaikan.
- [ ] Baseline migrasi Lucid ditandai sudah jalan, lalu `backend-api/` dihapus dari repo.
- [ ] `php8.3-fpm` dan `lacak-queue` dimatikan.

## Cara memindahkan satu modul

1. Porting tes Pest modul itu ke Japa lebih dulu, dan pastikan tes itu lolos melawan Laravel lewat HTTP.
2. Tulis ulang modul di Adonis sampai tes yang sama lolos.
3. Bandingkan respons kedua backend untuk request yang sama (contoh dari log nginx), termasuk saat error.
4. Arahkan path-nya di nginx ke Adonis dan pantau log error selama 1–2 hari.
5. Kalau ada masalah, kembalikan baris nginx itu; datanya tetap sama karena satu database.

## Risiko utama

| Risiko | Akibat kalau salah | Penanganan |
|---|---|---|
| Format `Crypt` Laravel | Semua staf tidak bisa verifikasi 2FA | Test vektor dari secret asli (didekripsi Laravel di server) sebelum Tahap 2 |
| Verifikasi bcrypt `$2y$` | Tidak ada yang bisa login | Tes dengan hash dari database produksi |
| Token Sanctum | Semua sesi terputus | Guard kustom diuji dengan token Laravel asli |
| Signed URL | Unduhan APK/dokumen/gambar gagal | Signer kompatibel selama masa transisi |
| Format `activity_log` | Menu Log aktivitas rusak | Bandingkan baris dari kedua backend |
| Build APK | Build gagal | Cek dulu di mesin mana build dijalankan |
| Dua backend menulis tabel yang sama | Data tidak konsisten | Satu modul hanya dilayani satu backend pada satu waktu |

## Yang perlu diputuskan sebelum mulai

1. **Satu aplikasi atau dua?** Backend dibuat sebagai aplikasi Adonis baru, atau digabung ke `realtime-gateway`. Saran: aplikasi baru dulu, digabung setelah stabil.
2. **Antrean:** Redis (BullMQ) atau tetap tabel `jobs` di Postgres.
3. **Build APK:** apakah tetap dibutuhkan, dan dijalankan di VPS atau di PC Windows.
4. **Account Center:** apakah sudah dipakai di produksi. Kalau belum, bisa dipindah paling akhir.
