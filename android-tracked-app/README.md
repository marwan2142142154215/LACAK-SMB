# Lacak SMB — APK Pelacak (Device Target)

APK yang dipasang di device yang dipantau (aset perusahaan / anak di bawah
umur). Menerima perintah dari [realtime-gateway](../realtime-gateway) lewat
Socket.IO, selalu online di latar belakang, dan bisa dikunci jarak jauh
lewat Device Admin API resmi Android.

## ⚠️ Status: Fondasi — BELUM diverifikasi compile

Kode di repo ini sudah ditulis lengkap untuk tahap fondasi (lihat di bawah),
tapi **belum berhasil di-build** di sesi pengembangan ini karena blocker
lingkungan: Gradle (semua versi yang dicoba: 8.9, 9.3.0) gagal start karena
`java.nio.channels.Selector.open()` butuh Unix Domain Socket untuk pipe
internal, dan AF_UNIX diblokir khusus untuk proses Java di sandbox sesi ini
(provider kernel `afunix.sys` aktif, tapi socket tetap gagal — kemungkinan
kebijakan keamanan level proses, bukan driver). Ini terjadi dengan 2 JDK
berbeda (Temurin 17 sistem & JBR 25 bawaan Android Studio), jadi bukan bug
JDK tertentu.

**Sebelum dipakai nyata, build & verifikasi dulu** (per android-apk-pro
checklist):
```powershell
cd android-tracked-app
.\gradlew.bat clean assembleDebug
.\gradlew.bat lint
adb -s R9RXC03EC9N install -r app\build\outputs\apk\debug\app-debug.apk
```
Catatan: `gradlew.bat`/`gradlew` dan `gradle-wrapper.jar` belum ter-generate
di repo ini (langkah itu sendiri yang gagal karena blocker di atas) — jalankan
`gradle wrapper --gradle-version 8.13` dulu kalau project dibuka di Android
Studio (yang biasanya punya jalur Gradle sendiri yang berbeda dari sesi
command-line ini).

## Fitur yang sudah ditulis (fondasi)
- **Enrollment**: layar Compose untuk isi kode site + alamat gateway,
  generate & tampilkan `device_uuid` (buat didaftarkan admin lewat
  dashboard), alur minta izin berurutan (lokasi, Bluetooth, notifikasi,
  lokasi latar belakang via Settings, Device Admin, pengecualian baterai)
- **Foreground service selalu hidup** (`TrackerForegroundService`):
  notifikasi persisten yang jujur ("Lacak SMB sedang memantau" — tidak
  menyembunyikan diri, sesuai standar android-apk-pro §4), koneksi Socket.IO
  auto-reconnect ke gateway `/device`, heartbeat baterai tiap 30 detik,
  restart otomatis via `BootCompletedReceiver` (hanya jika sudah pernah
  di-enroll)
- **Device Admin** (`TrackerDeviceAdminReceiver`): kemampuan minimal
  `force-lock` saja — perintah `lock` dari gateway memanggil
  `DevicePolicyManager.lockNow()`, balas `command:ack`
- **Belum ditulis** (iterasi berikutnya, sesuai kesepakatan "fondasi dulu"):
  scan BLE nyata untuk radar jarak, pelaporan GPS titik koordinat
  sebenarnya, verifikasi checksum APK anti-duplikasi di sisi device,
  anti-uninstall, layar OTP self-unlock

## Teknologi
- Kotlin, Gradle Kotlin DSL + version catalog (`gradle/libs.versions.toml`)
- AGP 8.13.2, Kotlin 2.2.20, compileSdk/targetSdk 36, **minSdk 26** (Android
  8.0 — sesuai permintaan dukungan Android 8 s/d 16)
- Jetpack Compose + Material 3, DataStore Preferences (identitas device),
  socket.io-client (Java), OkHttp (transitif), WorkManager (disiapkan,
  belum dipakai di fondasi ini)

## Package & identitas
`com.lacaksmb.tracker` — tema visual (warna) disamakan dengan
[web-dashboard](../web-dashboard) supaya satu identitas produk.

## Device uji yang tersedia
Device/emulator berikut sudah terhubung lewat `adb` di lingkungan
pengembangan: `R9RXC03EC9N` (diperuntukkan APK pelacak ini) dan
`R9RY506354P` (diperuntukkan APK master).

## Penanggung jawab
- Tim            : Internal
- Developer      : Marwan (dengan Claude Code)
- Divisi pengguna: Pemilik sistem

## Tautan terkait
- Realtime gateway (AdonisJS): [../realtime-gateway](../realtime-gateway)
- Skema database             : [../docs/skema-database.md](../docs/skema-database.md)
