# APK SMB Pelacak — pemasangan, Device Owner (QR), perintah & data

Panduan untuk admin/teknisi yang memasang APK SMB Pelacak (`android-tracked-app`) di **HP aset
perusahaan** yang pemegangnya sudah menandatangani persetujuan (consent) di sistem.

## 1. Membuat APK (menu Build APK)

1. Dashboard → **Build APK** → **Buat build APK** → jenis **SMB Pelacak**, pilih site, versi
   (format `x.y.z`), dan **nama device** (mis. "HP CS Line — Asep").
2. Server langsung membuat baris device (status *Menunggu daftar*) dengan `device_uuid` + rahasia
   device, lalu menanamnya ke APK (zero-touch). **Satu APK = satu HP**, otomatis terdaftar ke site
   yang dipilih — tidak ada kode pairing/OTP yang perlu diketik.
3. `versionCode` diturunkan dari versi (`1.2.3` → `10203`), jadi APK versi lebih baru bisa dipasang
   menimpa versi lama tanpa uninstall.
4. Setelah status **Berhasil**, menu ⋯ → **Panduan pasang & QR** menampilkan langkah pasang dan QR
   Device Owner.

## 2. Pasang di HP yang sudah dipakai (sideload)

1. Unduh APK di HP tujuan, izinkan "Instal aplikasi tak dikenal", instal.
2. Buka **SMB Pelacak** → **Mulai penyiapan**. Aplikasi meminta izin **berurutan**, masing-masing
   dengan penjelasan, dan otomatis lanjut setelah kembali dari halaman Setelan:

   | # | Langkah | Untuk apa |
   |---|---------|-----------|
   | 1 | Izin lokasi (akurat) | Mengirim posisi HP |
   | 2 | Lokasi "Izinkan sepanjang waktu" | Posisi tetap terkirim saat layar mati |
   | 3 | Notifikasi | Notifikasi pemantauan yang selalu tampil |
   | 4 | Admin perangkat | Kunci layar jarak jauh (hanya *force-lock*, tidak bisa hapus data) |
   | 5 | Tampil di atas aplikasi lain | Layar kunci bisa muncul dari latar belakang (Android 10+) |
   | 6 | Tanpa batasan baterai | Service & perintah tidak ditahan Doze |
   | 7 | Perangkat sekitar/Bluetooth (opsional) | Radar jarak dekat |

3. Pemantauan **langsung aktif begitu izin lokasi diberikan**; langkah lain menambah keandalan.
   Setiap kali aplikasi dibuka, semua izin dibaca ulang dari sistem — izin yang dicabut tampil
   sebagai "Perlu tindakan" dan dilaporkan ke dashboard (label **izin kurang** di menu Device).
4. HP Xiaomi/Oppo/Vivo/Realme/Infinix/dll.: ikuti kartu "Khusus HP …" (aktifkan *Mulai otomatis*).
5. Selesai bila layar menampilkan **Terhubung ke server** dan device *Online* di menu Device.

## 3. HP kantor baru: provisioning Device Owner lewat QR

Untuk HP yang **baru atau di-reset pabrik** (semua data di HP terhapus saat reset). Sebagai Device
Owner, SMB Pelacak memberi izin lokasi/Bluetooth/notifikasi untuk dirinya sendiri, boleh membuka
layar kunci dari latar belakang, dan memakai *lock task* penuh (gesture keluar dimatikan sistem).

1. Dashboard → Build APK → ⋯ → **Panduan pasang & QR** → tab **HP kantor baru (QR)** →
   **Tampilkan QR**. QR berisi tautan unduh bertanda tangan (berlaku **2 jam**) + checksum SHA-256
   APK. Pembuatan QR dicatat di log aktivitas. Jangan foto/bagikan QR (APK memuat kunci device).
2. Di HP: layar sambutan pertama → **ketuk 6 kali** di tempat yang sama → pemindai QR terbuka.
3. Sambungkan WiFi bila diminta, pindai QR. Android mengunduh APK, memeriksa checksum, memasang
   sebagai pengelola HP, lalu menampilkan layar persetujuan bawaan Android (Android 12+ juga
   menanyakan apakah admin boleh mengatur izin sensor — pilih **izinkan**).
4. Setelah penyiapan selesai, buka SMB Pelacak sekali; biasanya hanya "Tanpa batasan baterai" yang
   perlu disetujui manual.

Detail teknis:

- Payload QR: `PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME` =
  `com.lacaksmb.tracker.debug/com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver` (build dari
  server adalah varian debug), `..._PACKAGE_DOWNLOAD_LOCATION`, `..._PACKAGE_CHECKSUM` (SHA-256 berkas
  APK, base64 URL-safe), `PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED=true`.
  Lihat `backend-adonis/app/services/DeviceOwnerProvisioning.ts`, endpoint
  `GET /api/v1/apk-builds/:id/provisioning` (izin `apk-builds.manage`, hanya APK pelacak berstatus berhasil).
- APK menyediakan `ProvisioningModeActivity` (`GET_PROVISIONING_MODE`, selalu *fully managed*) dan
  `PolicyComplianceActivity` (`ADMIN_POLICY_COMPLIANCE`) yang wajib sejak Android 12, plus
  `onProfileProvisioningComplete` untuk Android 8–9. Keduanya memanggil `DeviceOwnerSetup`.
- Tautan unduh dibentuk dari `LARAVEL_APP_URL` backend (sama dengan tombol Unduh) -- harus HTTPS
  publik yang bisa diakses HP saat penyiapan.
- Alternatif untuk HP tanpa akun Google (uji/teknisi):
  `adb shell dpm set-device-owner com.lacaksmb.tracker.debug/com.lacaksmb.tracker.admin.TrackerDeviceAdminReceiver`
- Melepas Device Owner: lewat alur **Lepas perangkat** (bagian 4, butuh kode dari admin) atau reset pabrik.

## 4. Kunci lokasi & anti-hapus (Device Owner), dan melepas perangkat

Begitu HP menjadi **Device Owner**, `DeviceOwnerSetup.applyIfDeviceOwner` menerapkan (dan memasang
ulang tiap service start) kebijakan resmi Android — hanya hal yang dijelaskan di layar APK dan
dokumen consent:

- **Lokasi/GPS dikunci menyala**: `DISALLOW_CONFIG_LOCATION` (Android 9+) + `setLocationEnabled(true)`
  (Android 11+). Selama aplikasi aktif, pemegang HP tidak bisa mematikan lokasi.
- **Aplikasi tidak bisa dihapus**: `setUninstallBlocked(true)` — uninstall butuh kode lepas dari admin.

**HP non-Device-Owner** (hanya Device Admin / sideload biasa): kebijakan di atas tidak bisa
dipaksakan. Sebagai gantinya HP **melaporkan** status GPS; saat lokasi dimatikan, dashboard menandai
"Lokasi/GPS dimatikan" (kartu Kontrol perusahaan + banner) dan HP menampilkan notifikasi meminta
staf menyalakannya lagi. Lihat kolom `devices.location_service_on`.

Status ini tampil di **menu Device → detail perangkat → kartu "Kontrol perusahaan"**: mode
pengelolaan (Device Owner / Device Admin / biasa), "Lokasi/GPS dikunci menyala", dan "Aplikasi
dikunci (anti-hapus)". Dilaporkan lewat `device:info`
(`locationPolicyLocked`/`uninstallLocked`/`locationServiceOn`).

### Melepas perangkat (HP dikembalikan / diganti / rusak)

1. Dashboard → detail perangkat → **Buat kode lepas perangkat** (izin `devices.manage`; dicatat di
   log aktivitas sebagai `release_code_issued`). Kode 6 digit berlaku **15 menit**.
2. Berikan kode ke staf pemegang HP. Di aplikasi SMB Pelacak → kartu **"Perangkat dikunci
   perusahaan"** → **Lepas perangkat** → masukkan kode.
3. APK memverifikasi kode ke `POST /api/v1/device-otp/release`. Server menandai device **dilepas**
   (`is_active=false`, `released_at`), sehingga gateway tidak lagi menerimanya. HP lalu: hentikan
   pemantauan, cabut blokir uninstall + kunci lokasi, dan lepas status Device Owner/Admin
   (`DevicePolicyRelease`). Setelah itu aplikasi bisa dihapus seperti aplikasi biasa.
4. **Device Admin saja** (bukan Owner): `onDisableRequested` hanya bisa menampilkan peringatan — kode
   lepas tetap dipakai untuk melepas status admin secara bersih dan menandai device dilepas, lalu
   staf menghapus aplikasi manual.

Kalau HP rusak/hilang sebelum sempat dilepas, device bisa dinonaktifkan dari dashboard (hapus/arsip)
tanpa kode — gateway menolaknya saat mencoba terhubung.

## 5. Perintah jarak jauh (lock / unlock / locate_now)

Alur: dashboard → `device_commands` (status `pending`) → `realtime-gateway` CommandDispatcher →
`command:push` ke socket HP → HP melapor lewat `command:ack`.

| Status | Arti |
|--------|------|
| `pending` | Menunggu HP online (HP mati/offline; dikirim otomatis begitu terhubung, termasuk setelah HP dinyalakan ulang) |
| `delivered` | Sudah dipancarkan ke socket HP; dikirim ulang tiap 20 detik selama belum dikonfirmasi (maks. 8 kali → `failed`) |
| `acknowledged` | HP menerima perintah |
| `executed` | HP selesai menjalankan; `result_message` berisi hasil (mis. "Layar kunci tampil di HP", "Lokasi baru terkirim (GPS, akurasi ±12 m)") |
| `failed` | Gagal; `result_message` berisi alasan (izin belum ada, GPS mati, tidak dikonfirmasi) |
| `expired` | Kedaluwarsa (`locate_now` > 10 menit) atau digantikan perintah kunci/buka yang lebih baru |

- Lock/unlock **tidak pernah kedaluwarsa karena umur** — hanya perintah kunci/buka terbaru per HP
  yang dikirim. HP mencatat perintah yang sudah dijalankan (`CommandLedger`) sehingga kiriman ulang
  tidak menjalankan dua kali.
- Status kunci juga disimpan di HP (`DeviceLockStore`), jadi kunci tetap berlaku setelah HP
  dinyalakan ulang walau belum ada sinyal.
- Dashboard menampilkan status perintah terakhir per device (kolom **Perintah terakhir**), riwayat
  lengkap di dialog **Detail perangkat**, dan memperbarui keduanya langsung lewat event
  `device:command` dari gateway.
- Service tetap hidup lewat: foreground service `START_STICKY`, `BootCompletedReceiver`
  (`BOOT_COMPLETED`, `QUICKBOOT_POWERON`, `MY_PACKAGE_REPLACED`), watchdog WorkManager tiap 15
  menit, dan sambung ulang seketika saat jaringan kembali.
- **Tidak ada FCM/push Google** di proyek ini. Selama HP tidak punya koneksi data, perintah
  menunggu di server. Menambah FCM butuh proyek Firebase + `google-services.json` (keputusan
  terpisah).

## 6. Data yang dikirim HP (dan yang tidak)

Diungkapkan di layar APK (kartu "Data yang dikirim ke kantor") dan disaring ulang di gateway
(`realtime-gateway/app/services/DeviceTelemetry.ts` — field lain di payload diabaikan):

- `device:location` tiap 15 detik + saat `locate_now`: lat/lng, akurasi (m), sumber fix
  (`gps`/`network`/`fused`/`passive`), waktu fix, baterai %, nama WiFi, jarak BLE.
- `device:info` saat terhubung, tiap 5 menit, dan saat `locate_now`: merek, model, versi Android,
  versi app (`versionName`/`versionCode`), baterai & status cas, jenis jaringan + nama operator,
  sisa/total penyimpanan, status izin aplikasi ini, serta status kebijakan kunci (lokasi dikunci
  menyala, aplikasi dikunci anti-hapus) dan status GPS saat ini.

**Tidak dikumpulkan:** isi pesan, kontak, riwayat panggilan, foto/berkas, daftar atau isi/penggunaan
aplikasi lain, nomor telepon, IMEI. APK tidak meminta izin untuk data tersebut, dan notifikasi
"Lacak SMB sedang memantau" selalu tampil — aplikasi tidak menyembunyikan diri.

Kolom baru (migrasi `backend-adonis/database/migrations/0018_device_telemetry_and_command_status.ts`):
`devices.manufacturer/model/app_version_code/is_charging/network_type/carrier_name/
storage_free_mb/storage_total_mb/permission_state/info_updated_at`,
`device_locations.accuracy_meters/location_provider/fixed_at`,
`device_commands.delivered_at/executed_at/result_message/delivery_attempts` + status `executed`, `expired`.

Kunci & pelepasan (migrasi `0019_device_policy_lock_and_release.ts`):
`devices.location_policy_locked/uninstall_locked/location_service_on/released_at`. Kode lepas memakai
`device_otps.purpose = 'release'` (verifikasi tanpa login di `POST /api/v1/device-otp/release`).
