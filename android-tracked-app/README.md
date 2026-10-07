# Lacak SMB — APK Pelacak (Device Target)

APK yang dipasang di device yang dipantau (aset perusahaan / anak di bawah
umur). Menerima perintah dari [realtime-gateway](../realtime-gateway) lewat
Socket.IO, selalu online di latar belakang, dan bisa dikunci jarak jauh
lewat Device Admin API resmi Android.

## ✅ Status: Fondasi — terverifikasi build & jalan di device nyata

Build Gradle via command-line Windows diblokir sandbox sesi ini (AF_UNIX
pada `Selector.open()` ditolak khusus untuk proses Java — dicoba 2 JDK beda,
2 versi Gradle beda, hasil identik). **Jalan keluarnya: build lewat WSL2**
(kernel Linux WSL tidak kena restriksi yang sama sama sekali). Alur yang
dipakai dan terbukti berhasil:

```bash
# Di WSL2 Ubuntu, dari folder project (diakses via /mnt/c/...)
./gradlew assembleDebug   # BUILD SUCCESSFUL
./gradlew lint            # 0 error setelah perbaikan di bawah
```

APK hasil build (`app/build/outputs/apk/debug/app-debug.apk`) lalu
di-**install lewat `adb.exe` Windows biasa** (USB tetap lewat Windows, WSL2
tidak perlu USB passthrough):
```powershell
adb -s R9RXC03EC9N install -r app\build\outputs\apk\debug\app-debug.apk
```

**Diuji nyata di device fisik `R9RXC03EC9N`**: app terpasang, diluncurkan,
tidak crash (`ps` menunjukkan proses hidup, tidak ada `FATAL EXCEPTION` di
logcat), dan layar enrollment Compose tampil benar — termasuk `device_uuid`
yang berhasil di-generate (`198a1eb0-c64d-40ea-875f-1d66597cc568` pada
pengujian ini) dan dialog izin lokasi Android asli muncul saat diminta.

**1 bug nyata ditemukan & diperbaiki oleh Android Lint**:
`BIND_DEVICE_ADMIN` sempat dideklarasikan sebagai `<uses-permission>`
aplikasi di manifest — itu salah, permission itu level-sistem (protected)
dan hanya boleh muncul di atribut `android:permission` pada `<receiver>`
Device Admin, bukan diminta aplikasi untuk dirinya sendiri. Lint menolak
build karena ini (`ProtectedPermissions` error); sudah dihapus.

Untuk membangun ulang: coba dulu langsung di Windows/Android Studio
(`./gradlew.bat clean assembleDebug`) — kalau kena error AF_UNIX yang sama,
pakai [`scripts/build-in-wsl.sh`](scripts/build-in-wsl.sh) dari WSL2.

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
