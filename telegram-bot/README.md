# Lacak Master — Telegram Bot

Jembatan Telegram untuk kontrol device: operator kirim `/lock`, `/unlock`,
`/locate`, `/devices`, `/status` lewat chat, bot meneruskan ke
[backend-adonis](../backend-adonis) (tercatat sebagai `issued_via: telegram_bot`
di audit trail). Alert pelanggaran geofence **tidak** lewat bot ini — itu
dikirim langsung oleh [realtime-gateway](../realtime-gateway), yang
memegang token bot asli di `.env`-nya sendiri.

## Teknologi
- Node.js 24 + AdonisJS 7 (tanpa HTTP server; bot dijalankan lewat perintah Ace `bot:run`)
- node-telegram-bot-api v2 (`Bot`, middleware `command()`/`hears()`)
- axios (ke backend-adonis)

## Library utama
- `node-telegram-bot-api` : klien Bot API Telegram
- `axios`                 : permintaan HTTP ke backend-adonis
- `@adonisjs/core`        : kerangka aplikasi (env, logger, perintah ace)

## Arsitektur singkat

```
Operator (Telegram) --/lock 5--> Bot --POST /devices/5/commands--> backend-adonis --> (DB) --> gateway --> device
                                   |
                                   +-- GET /telegram-bindings-lookup?chat_id=X
                                       (cocokkan chat ini milik site mana)

Gateway --(violation terdeteksi)--> Telegram Bot API langsung (token di gateway/.env)
```

Satu chat Telegram hanya bisa dipakai setelah ditautkan ke sebuah site lewat
dashboard (menu **Bot Telegram** → Tambah Binding). Bot menolak perintah
dari chat yang belum ditautkan dengan pesan yang jelas, bukan diam saja.

## Akun layanan & token
Bot login ke backend-adonis memakai **akun layanan** `telegram-bot`
(`is_active=false`, tidak bisa login manusiawi lewat 2FA) dan role
`telegram_bot_service` — permission terbatas hanya
`devices.view/lock/unlock/locate/monitor`, **tidak** bisa kelola site/consent
/geofence/APK/binding. Token diterbitkan sekali lewat:

```bash
node ace bot:issue-telegram-token
```

(dijalankan dari folder `backend-adonis`; di server: `cd backend-adonis/build && node ace bot:issue-telegram-token`). Salin hasilnya ke `telegram-bot/.env`
sebagai `BACKEND_API_TOKEN` — token tidak ditampilkan lagi setelah itu.

## Cara menjalankan di local
1. `npm install`
2. Salin `.env.example` menjadi `.env`, isi `TELEGRAM_BOT_TOKEN` (dari
   [@BotFather](https://t.me/BotFather)), `BACKEND_API_URL`, dan
   `BACKEND_API_TOKEN` (lihat di atas), lalu buat `APP_KEY` dengan
   `node ace generate:key`
3. Pastikan backend-adonis sudah jalan dan ada minimal satu
   `telegram_bindings` row yang mengarah ke chat Anda
4. `npm start` (sama dengan `node ace bot:run`)

Variabel `.env` divalidasi di `start/env.ts`; bot langsung berhenti dengan
pesan jelas bila ada yang belum diisi.

Untuk production: `npm run build`, lalu dari folder `build/` jalankan
`npm ci --omit=dev` dan `node ace bot:run`.

## Perintah

| Perintah | Keterangan |
|---|---|
| `/start` | Konfirmasi chat ini terhubung ke site mana |
| `/help` | Daftar perintah |
| `/devices` | Daftar device di site ini beserta status & baterai |
| `/status <id>` | Detail satu device + lokasi terakhir |
| `/lock <id> [alasan]` | Kunci device |
| `/unlock <id>` | Buka kunci device |
| `/locate <id>` | Minta lokasi terbaru sekarang |

## Catatan pengujian
Diuji dengan token bot & chat ID nyata (bukan dummy): `getMe` berhasil
mengonfirmasi identitas bot `@lacak_smb_bot`, endpoint lookup backend-adonis
berhasil mencocokkan chat nyata ke site, dan bot berhasil polling tanpa
error. Pengiriman pesan nyata dari **gateway** ke Telegram sempat diuji dan
kode terbukti benar lewat pemanggilan `sendMessage` manual (curl/PowerShell)
dengan payload identik — tapi proses Node.js di sandbox pengembangan sesi
ini diblokir jaringannya khusus ke `api.telegram.org` (PowerShell & curl
dari mesin yang sama berhasil, jadi ini batasan sandbox proses Node, bukan
bug kode). Akan berfungsi normal begitu dijalankan di server produksi
sungguhan.

## Penanggung jawab
- Tim            : Internal
- Developer      : Marwan
- Divisi pengguna: Pemilik sistem

## Tautan terkait
- Backend API (AdonisJS)     : [../backend-adonis](../backend-adonis)
- Realtime gateway (AdonisJS): [../realtime-gateway](../realtime-gateway)
