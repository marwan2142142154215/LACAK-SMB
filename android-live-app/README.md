# Lacak SMB Live (APK Live Kerja)

APK khusus staf untuk **Live Kerja dari HP**: tekan *Mulai kerja*, layar HP,
kamera depan, dan suara disiarkan ke atasan lewat LiveKit, dan siaran **tetap jalan saat staf
pindah aplikasi atau layar mati** — hal yang tidak bisa dilakukan dashboard
web/PWA, karena Chrome/Safari di HP menghentikan kamera begitu halaman masuk
latar belakang.

## Cara kerja

- Login + 2FA sama seperti APK Master (`/auth/login`, `/auth/2fa/*`).
- *Mulai kerja* → `LiveBroadcastService`, foreground service bertipe `camera`
  (`FOREGROUND_SERVICE_CAMERA`, Android 14+) dengan notifikasi permanen
  "Sedang menyiarkan". Menekan notifikasi membuka aplikasi; tombol
  *Selesai kerja* ada di layar dan di notifikasi.
- Berbagi layar: *Mulai kerja* meminta izin MediaProjection ("Bagikan seluruh
  layar", dipaksa layar penuh di Android 14+). Izinnya sekali pakai dan
  diserahkan ke service; LiveKit menjalankan foreground service
  `mediaProjection`-nya sendiri. Ditolak atau dihentikan dari sistem = status
  Screen off (tidak dihitung kerja) dan tombol *Bagikan layar* muncul.
- Cek wajah (`FaceWatch`, ML Kit di HP): satu frame kamera per detik; tidak
  ada wajah >= 30 detik = `face_missing` (log "Wajah hilang"/"Wajah kembali").
  Hanya dicatat, jam kerja tetap dihitung. APK hanya untuk HP ARM
  (`arm64-v8a`, `armeabi-v7a`).
- Background kamera (`BackgroundProcessor`): kamera asli, blur, gradasi
  bawaan, atau gambar galeri -- dipilih di layar Live Kerja, diingat di HP.
  Masker orang/latar dari ML Kit Selfie Segmentation (~8x/detik) pada frame
  kamera, digambar dengan shader `livekit-android-track-processors`. Frame
  tetap berasal dari kamera, jadi watchdog kamera & cek wajah tidak berubah.
- Memakai API backend yang sudah ada tanpa mengubah kontraknya:
  `POST /live/sessions/start` (→ `livekit_url`, `token`, `room`),
  `POST /live/sessions/heartbeat` tiap 30 detik + saat layar/kamera/istirahat
  berubah, berisi `camera_active`, `screen_active` & `on_break` (404 = sesi
  ditutup server → berhenti), `POST /live/sessions/end`.
- Tombol **Istirahat / Lanjut kerja** (di layar & notifikasi), sama dengan
  dashboard web: kamera & layar tetap disiarkan, server mencatat status Break
  dan jamnya tidak dihitung kerja. Status istirahat ikut sesi di server, jadi
  dilanjutkan saat app dibuka ulang.
- Perilaku LiveKit sama dengan `web-dashboard/src/stores/live.js`: kamera +
  mikrofon (tombol Bisukan di layar & notifikasi, pilihan bisu diingat), 720p + simulcast h180/h360,
  layar 1080p 15fps + lapis 360p/720p, dynacast, tidak berlangganan video
  peserta lain. Identitas `user-{id}` di room `site-{organization_id}`, jadi
  siaran langsung muncul di halaman Live Kerja dashboard.
- Tetap hidup di latar belakang: wake lock parsial + Wi-Fi lock selama siaran,
  sambung ulang otomatis kalau jaringan putus (memanggil `/start` lagi untuk
  token baru), dan watchdog kamera yang menyalakan ulang kamera kalau tidak
  ada frame baru dalam 10 detik (mis. kamera sempat direbut aplikasi lain).
- Izin mikrofon opsional: ditolak = siaran kamera tetap jalan tanpa suara.
  Foreground service bertipe `camera|microphone` (tipe microphone hanya
  dipakai kalau izinnya ada).

Catatan: login dengan akun yang sama di dashboard web lalu menekan Mulai kerja
di sana akan mengambil alih siaran (identitas LiveKit sama); APK akan berhenti
dengan pesan yang jelas.

## Menu kerja (tab bawah)

- **Live** native (di atas). **Chat, Briefing, Absensi, Izin & cuti, Pengumuman** dibuka dari
  dashboard web (`DASHBOARD_URL`, argumen ke-8 `build_only.sh`, env backend
  `LACAKSMB_PUBLIC_DASHBOARD_URL`) di satu WebView (`ui/DashboardWeb.kt`): fiturnya selalu sama
  dengan web/PWA tanpa menambah ukuran APK. Sesi login APK diteruskan ke localStorage dashboard,
  dan user agent diberi `LacakLiveApp` sehingga dashboard menyembunyikan menu samping, bar
  status, dan siaran web (`web-dashboard/src/lib/embedded.js`) -- siaran tetap lewat tab Live.
- **Peringatan atasan**: dicek tiap 30 detik saat aplikasi terbuka (dialog *Saya mengerti*) dan
  tiap detak siaran saat di latar belakang (notifikasi penting).

## Ukuran APK

`build_only.sh` membangun **rilis** (R8 + resource shrink), library native disimpan terkompresi
(`useLegacyPackaging`), dan model cek wajah memakai versi Google Play services (diunduh Play
services, tidak ikut APK). Kunci tanda tangan rilis: `-PliveKeystore=...` atau env
`LIVE_KEYSTORE`, `LIVE_KEYSTORE_PASSWORD`, `LIVE_KEY_ALIAS`, `LIVE_KEY_PASSWORD`; tanpa itu
ditandatangani kunci debug mesin build. Nama paket rilis `com.lacaksmb.live` (build debug lama
`com.lacaksmb.live.debug`), jadi HP yang memasang APK lama perlu memasang yang baru sekali.

## Build

Butuh JDK 17 dan Android SDK (platform 36). Isi `local.properties`:

```
sdk.dir=C\:\\path\\ke\\android-sdk
```

lalu:

```bash
./gradlew assembleDebug -PbackendApiUrl=https://api.salahmu.fun/api/v1
```

Hasilnya `app/build/outputs/apk/debug/app-debug.apk` (package
`com.lacaksmb.live.debug`). Tanpa `-PbackendApiUrl`, APK mengarah ke
`http://10.0.2.2:8000/api/v1` (emulator → backend lokal). Alamat LiveKit tidak
ditanam — datang dari respons `/live/sessions/start`.
