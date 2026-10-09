# Lacak Master — Realtime Gateway

Gateway WebSocket (Socket.IO) untuk radar BLE/GPS ribuan device sekaligus:
menerima laporan posisi dari APK pelacak, menyiarkan ke dashboard/APK master
secara realtime, mendeteksi pelanggaran geofence (WiFi/IP whitelist, jarak
BLE maksimum), dan mengirim perintah (lock/unlock/locate/monitor) ke device.

Gateway ini **tidak menyimpan data sendiri** — ia membaca/menulis langsung ke
database PostgreSQL yang sama dengan [backend-api](../backend-api) (Laravel).
Skema tabel sepenuhnya dikelola lewat migration Laravel; gateway hanya punya
model Lucid read/write ke tabel yang sudah ada. Satu sumber kebenaran skema,
dua runtime yang membacanya.

## Teknologi
- Node.js 24 (LTS saat ini)
- AdonisJS 6 (`@adonisjs/core` 7.x)
- Socket.IO 4
- `@adonisjs/lucid` + `pg` (PostgreSQL, sama dengan backend-api)

## Library utama
- `socket.io`      : server WebSocket untuk namespace `/device` dan `/ops`
- `@adonisjs/lucid` : ORM baca/tulis ke tabel milik backend-api (lihat catatan di atas)
- `pg`             : driver PostgreSQL untuk Lucid
- `luxon`          : tanggal/waktu di sisi AdonisJS (dipakai internal framework)

## Arsitektur singkat

```
APK pelacak (device) --[Socket.IO /device]--> Gateway --[Socket.IO /ops]--> Dashboard/APK master
                                                  |
                                                  v
                                        PostgreSQL (sama dgn Laravel)
                                                  ^
                                                  |
                              backend-api Laravel (CRUD, auth, 2FA) <--HTTP-- verifikasi token
```

- **Namespace `/device`**: dipakai APK pelacak. Wajib kirim `device:hello`
  `{ deviceUuid, siteCode }` dalam 10 detik atau diputus. Ditolak
  (`device:rejected`) kalau device tidak dikenal, site tidak aktif, kode site
  tidak cocok (APK bajakan/clone — pesan: *"silahkan download dari sumber
  resmi bosku"*), checksum APK terdaftar tidak cocok, atau consent sudah
  tidak berlaku.
- **Namespace `/ops`**: dipakai web dashboard & APK master. Wajib kirim
  `auth: { token }` (Bearer token Sanctum dari backend-api) saat connect —
  divalidasi dengan memanggil balik `GET /api/v1/auth/me` ke Laravel (gateway
  tidak menyimpan/memverifikasi password atau sesi sendiri). Auto-subscribe
  ke room `org:{organization_id}` miliknya; `super_admin` bisa
  `subscribe:organization` ke site mana pun.
- **Command dispatcher**: polling `device_commands` berstatus `pending`
  setiap `COMMAND_POLL_INTERVAL_MS` (default 2 detik), kirim ke device yang
  sedang terkoneksi, tandai `delivered`. Device membalas `command:ack` untuk
  menandai `acknowledged`. Satu-satunya jalur pengiriman — dipakai juga oleh
  perintah otomatis (lihat di bawah).
- **Auto-lock geofence**: kalau jarak BLE device melebihi
  `geofence_rules.max_distance_meters`, gateway otomatis membuat
  `device_commands` (lock) atas nama akun `system-automation` (lihat
  backend-api `SystemAccountSeeder`) — bukan menyamar sebagai admin manusia,
  tetap ada jejak audit yang jujur.

## Cara menjalankan di local
1. `npm install`
2. Salin `.env.example` menjadi `.env`, sesuaikan `DB_*` (sama dengan
   `backend-api/.env`) dan `BACKEND_API_URL`
3. Pastikan PostgreSQL & Redis sudah jalan (lihat catatan WSL2 di README
   backend-api) dan backend-api sudah di-migrate+seed (gateway butuh tabel
   yang dibuat migration Laravel, termasuk akun `system-automation`)
4. `npm run dev` — jalan di `http://localhost:3333`

## Event Socket.IO

### `/device` (dari APK pelacak)
| Event | Arah | Payload |
|---|---|---|
| `device:hello` | kirim | `{ deviceUuid, siteCode, appBuildVersion?, checksumSha256?, deviceSecret? }` |
| `device:accepted` | terima | `{ deviceId, status }` |
| `device:rejected` | terima | `{ message }` |
| `device:location` | kirim | `{ source, latitude?, longitude?, bleDistanceMeters?, bleRssi?, batteryLevel?, ssid?, ip? }` |
| `command:push` | terima | `{ command_id, command_type, reason_note }` |
| `command:ack` | kirim | `{ commandId }` |

### `/ops` (dari web dashboard / APK master)
| Event | Arah | Payload |
|---|---|---|
| `subscribe:organization` | kirim | `organizationId` (number) |
| `subscribe:confirmed` / `subscribe:rejected` | terima | `{ organizationId }` |
| `radar:update` | terima | posisi device terbaru |
| `violation:alert` | terima | pelanggaran geofence |
| `device:status` | terima | perubahan status device |

## Penanggung jawab
- Tim            : Internal
- Developer      : Marwan
- Divisi pengguna: Pemilik sistem (aset perusahaan / parental control)

## Tautan terkait
- Backend API (Laravel) : [../backend-api](../backend-api)
- Skema database        : [../docs/skema-database.md](../docs/skema-database.md)
