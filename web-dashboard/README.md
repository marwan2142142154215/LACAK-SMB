# Lacak Master — Web Dashboard

Dashboard web untuk sistem MDM legal (pelacakan aset perusahaan, parental
control, Find My Device): login wajib + 2FA, radar realtime (BLE/GPS),
manajemen device/site/consent/geofence/APK/Telegram. Konsumsi penuh dari
[backend-api](../backend-api) (Laravel) untuk data & auth, dan
[realtime-gateway](../realtime-gateway) (AdonisJS) untuk radar/alert live
lewat Socket.IO.

## Teknologi
- Node.js 24 (LTS saat ini)
- Vue 3.5 + Vite 8
- Tailwind CSS 4
- Pinia (state), Vue Router (navigasi)

## Library utama
- axios              : permintaan HTTP ke backend-api
- @lucide/vue         : ikon
- reka-ui             : primitif Dialog, Toast (tampilan ditulis sendiri dengan Tailwind)
- dayjs               : format tanggal/waktu
- socket.io-client    : koneksi realtime ke gateway (radar, alert, status device)
- @tanstack/vue-table, apexcharts, vee-validate : tersedia untuk pengembangan fitur lanjutan

## Desain
Tema gelap dengan aksen tosca/emerald (`--color-accent-*`) dan tembaga
(`--color-copper-*`) — dimaksudkan terasa seperti panel kontrol keamanan,
bukan dashboard SaaS generik. Semua token warna ada di
[src/style.css](src/style.css). Sidebar otomatis jadi drawer di layar
sempit (standar 9.3: wajib bisa dipakai di laptop maupun ponsel).

## Cara menjalankan di local
1. `npm install`
2. Salin `.env.example` menjadi `.env`, sesuaikan `VITE_API_BASE_URL` dan `VITE_GATEWAY_WS_URL`
3. Pastikan backend-api (port 8010) dan realtime-gateway (port 3333) sudah jalan
4. `npm run dev` — buka `http://localhost:5173`

## Alur login
Sama seperti yang dijelaskan di README backend-api: login pertama kali
memaksa scan QR 2FA, login berikutnya minta kode 2FA. Token Bearer disimpan
di `localStorage` lewat Pinia store [src/stores/auth.js](src/stores/auth.js)
dan dipasang otomatis ke tiap request lewat interceptor Axios di
[src/main.js](src/main.js).

## Catatan pengujian
Diuji penuh lewat built-in browser: login → setup 2FA (QR) → verifikasi →
buat site → buat aturan geofence → buat & hapus binding Telegram → logout →
route guard menolak akses tanpa login → tampilan mobile (drawer sidebar).
Dua bug ditemukan & diperbaiki selama pengujian:
- `router-link` memakai `active-class` bawaan (pencocokan prefix path) yang
  membuat menu "Radar" (path `/`) ikut tersorot di semua halaman lain →
  diganti ke `exact-active-class`.
- Sidebar mobile (drawer) tidak terbuka karena dua utility Tailwind yang
  saling bertentangan (`-translate-x-full` & `translate-x-0`) dipasang
  sekaligus lewat `:class` object — Tailwind mengurutkan utility di
  stylesheet berdasarkan posisinya sendiri, bukan urutan atribut class, jadi
  kondisi Vue diam-diam tidak berefek → diganti jadi satu class dinamis
  (ternary) agar hanya salah satu yang pernah aktif.

Upload file (consent document, APK) divalidasi lewat pengujian API langsung
terhadap backend-api (lihat README backend-api) — automasi file-picker
native OS di luar cakupan alat uji browser yang dipakai.

## Penanggung jawab
- Tim            : Internal
- Developer      : Marwan (dengan Claude Code)
- Divisi pengguna: Pemilik sistem (aset perusahaan / parental control)

## Tautan terkait
- Backend API (Laravel)      : [../backend-api](../backend-api)
- Realtime gateway (AdonisJS): [../realtime-gateway](../realtime-gateway)
- Skema database             : [../docs/skema-database.md](../docs/skema-database.md)
