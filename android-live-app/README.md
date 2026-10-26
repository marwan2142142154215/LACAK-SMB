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
  `POST /live/sessions/heartbeat` tiap 30 detik + saat layar/kamera berubah,
  berisi `camera_active` & `screen_active` (404 = sesi ditutup server →
  berhenti), `POST /live/sessions/end`.
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
