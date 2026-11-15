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

## Fitur

Panduan lengkap pemasangan, QR Device Owner, status perintah, dan daftar data yang dikirim:
[docs/provisioning-device-owner.md](../docs/provisioning-device-owner.md).

- **Zero-touch**: APK dari menu Build APK membawa `site_code`, alamat server, `device_uuid`, dan
  rahasia device -- langsung terdaftar ke site yang benar, tanpa pairing.
- **Layar panduan** (`ui/MainActivity`): checklist izin berurutan dengan penjelasan (lokasi,
  lokasi sepanjang waktu, notifikasi, Admin perangkat, tampil di atas app lain, baterai, Bluetooth
  opsional), dibaca ulang dari sistem setiap layar tampil (`setup/SetupChecks`). Pemantauan mulai
  begitu izin lokasi ada. Kartu pengungkapan data + tips Autostart untuk merek HP agresif.
- **Device Owner via QR** (`admin/ProvisioningActivities`, `admin/DeviceOwnerSetup`): izin diberi
  otomatis, lock task penuh.
- **Foreground service** (`service/TrackerForegroundService`): notifikasi jujur yang selalu tampil,
  socket.io ke gateway `/device`, sambung ulang saat jaringan kembali, heartbeat lokasi 15 detik
  (akurasi, sumber, waktu fix -- `service/LocationTracker`), detail perangkat tiap 5 menit
  (`service/DeviceInfoCollector`), hidup lagi lewat `BootCompletedReceiver` (boot, quickboot,
  update APK) dan watchdog WorkManager (`service/ServiceWatchdogWorker`).
- **Perintah dengan laporan hasil**: `lock` / `unlock` / `locate_now` dikonfirmasi diterima lalu
  dilaporkan dijalankan/gagal beserta alasannya; kiriman ulang dari gateway tidak dijalankan dua
  kali (`data/CommandLedger`).
- **Lock jarak jauh**: `LockActivity` layar penuh + screen pinning + OTP self-unlock, status kunci
  persisten (`data/DeviceLockStore`), Device Admin `force-lock` saja.
- **BLE**: beacon + scan untuk radar jarak dekat & anchor geofence.

## Build lokal

Checkout Windows memakai CRLF -- build dari salinan di WSL:

```bash
rsync -a --exclude build --exclude .gradle "/mnt/d/SMB Optimasi Project/lacak-hp/android-tracked-app/" ~/live-build/android-tracked-app/
cd ~/live-build/android-tracked-app && find . -name gradlew -o -name "*.sh" | xargs sed -i 's/$//'
ANDROID_HOME=~/android-sdk bash ./gradlew assembleDebug lintDebug -PsiteCode=SITE-UJI -PgatewayUrl=https://contoh.test -PsiteName="Site Uji" -PappVersionName=1.2.0 -PbackendApiUrl=https://contoh.test/api/v1
```

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
- Developer      : Marwan
- Divisi pengguna: Pemilik sistem

## Tautan terkait
- Realtime gateway (AdonisJS): [../realtime-gateway](../realtime-gateway)
- Skema database             : [../docs/skema-database.md](../docs/skema-database.md)
