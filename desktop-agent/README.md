# Lacak SMB — Agen Desktop (PC)

Aplikasi tray Windows (Electron) yang **memantau lokasi PC staf selama login/bekerja**
dan mengirimkannya ke server Lacak SMB. Dibuat untuk melengkapi APK (HP): bersama-sama
melacak staf di HP **dan** PC.

## Mengapa Electron + `navigator.geolocation`?

- Pelacakan harus **jalan di latar belakang** (tab browser tidak bisa) → aplikasi native.
- **Tahan-VPN**: lokasi diambil dari **perangkat (GPS/WiFi)**, bukan IP. VPN hanya mengubah
  IP, jadi lokasi perangkat tidak terpengaruh.
- Di Windows, Chromium (dalam Electron) memakai **Windows Location Service** (WiFi/GPS)
  untuk `navigator.geolocation` — bukan IP — sehingga tahan-VPN **tanpa API key berbayar**.
  Geolokasi hanya tersedia di renderer, jadi ada satu jendela tersembunyi
  (`src/windows/geo.html`) yang menjalankan `watchPosition` dan mengirim fix ke main.

> **Keputusan spike (terbuka):** jalur utama = `navigator.geolocation` (Windows Location
> Service). Jika pada versi Electron/mesin tertentu geolokasi tidak mengembalikan posisi
> (jatuh ke penyedia jaringan Google yang butuh API key), alternatifnya memakai modul native
> **WinRT `Windows.Devices.Geolocation`**. Perlu diuji di Windows nyata sebelum diputuskan.

## Arsitektur

```
src/
  main.js        proses utama: tray, autostart, jendela, IPC, GATE wajib-lokasi
  preload.js     jembatan aman renderer<->main (contextIsolation)
  config.js      URL server + simpan token (safeStorage/DPAPI)
  auth.js        login staf (POST /auth/login) di main (kredensial tak ke renderer)
  reporter.js    socket.io /ops -> emit `staff:location`
  windows/
    login.html   form login
    geo.html     jendela tersembunyi: navigator.geolocation.watchPosition
    gate.html    layar penghalang "Aktifkan lokasi untuk melanjutkan"
```

Kontrak server (sudah ada di repo): login `POST {API}/auth/login` `{username,password,client:'web_dashboard'}`;
gateway Socket.IO `{GATEWAY}/ops`, handshake `auth:{token}`, emit `staff:location`
`{latitude,longitude,accuracy,source,isMock,client:'desktop'}`. Server (StaffLocationHub)
memvalidasi, membatasi laju ~15 dtk, menilai `confidence`, menyimpan, menyiarkan ke pengawas.

## Wajib lokasi

Jika layanan lokasi mati / izin ditolak / tak dapat fix, muncul **jendela penghalang**
(`gate.html`) dan tidak ada lokasi dikirim — efektifnya staf tak bisa "bekerja" lewat agen
ini sampai lokasi diaktifkan. (Lihat `showGate`/`geo:error` di `main.js`.)

## Menjalankan (pengembangan)

```bash
cd desktop-agent
npm install
# arahkan ke server (default dev lokal):
set AGENT_API_BASE=https://<api>/api/v1
set AGENT_GATEWAY_URL=https://<gateway-origin>
npm start
```

Atau buat `config.json` di folder data aplikasi (`%APPDATA%/lacak-smb-desktop-agent/`)
berisi `{ "apiBase": "...", "gatewayUrl": "...", "intervalMs": 25000 }`.

Cek sintaks main-process (tanpa Electron): `npm run check`.

## Build installer

```bash
npm run dist   # electron-builder -> installer NSIS Windows
```

## Belum selesai / belum teruji

- **Runtime GUI belum diuji** (tray, jendela, autostart) — perlu dijalankan di Windows.
- **Geolokasi belum diverifikasi** di Windows nyata; jika `navigator.geolocation` tak
  memberi posisi, siapkan fallback WinRT native (lihat "spike" di atas).
- **Ikon tray** masih placeholder 1×1 — ganti dengan `assets/tray.png` + referensikan di
  `trayIcon()`.
- **Penandatanganan kode & auto-update** belum disiapkan (installer tak ter-sign).
- **Deteksi mock/akurasi**: desktop tidak melaporkan mock; `source` diperkirakan dari
  akurasi, `confidence` dinilai server.
