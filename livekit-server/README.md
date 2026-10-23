# LiveKit Server — media server Live Kerja

Live Kerja (halaman `/live` di web-dashboard) menyiarkan kamera staf ke
semua rekan **di site yang sama**. Untuk >50 staf per site, video tidak
dikirim langsung antar-HP (peer-to-peer), tapi lewat media server ini (SFU):
tiap staf cukup mengirim **satu** stream, server yang membagikannya.

Isolasi antar-site **tidak** diatur di sini — server ini hanya menerima
token yang diterbitkan backend-api (`App\Services\LiveKitTokenIssuer`), dan
token itu mengunci tiap user ke room `site-{organization_id}` miliknya.

## Menjalankan

```bash
cp livekit.yaml.example livekit.yaml   # isi keys: dengan API key & secret baru
docker compose up -d
```

Isi nilai yang sama di `backend-api/.env`:

```
LIVEKIT_URL=wss://live.lacaksmbbot.com
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

## ⚠️ Port & jaringan (penting)

| Port | Protokol | Untuk |
|---|---|---|
| 7880 | TCP (WebSocket) | signaling — boleh lewat Cloudflare Tunnel / reverse proxy TLS sebagai `wss://live.lacaksmbbot.com` |
| 7882 | **UDP** | video — **harus** terbuka langsung ke internet (IP publik) |
| 7881 | TCP | cadangan video kalau UDP diblokir jaringan |

**Cloudflare Tunnel tidak bisa meneruskan UDP/WebRTC.** Signaling (7880)
boleh lewat tunnel seperti backend-api & gateway, tetapi port 7881/7882
wajib bisa dijangkau langsung di IP publik server (buka di firewall VPS).
Tanpa itu staf bisa "terhubung" tapi videonya tidak pernah muncul.

## Kapasitas (perkiraan)

Tiap staf mengirim simulcast 180p + 360p (+540p saat ada yang menonton
layar besar). Penonton hanya mengunduh video yang tampil di halaman grid
(12 per halaman), dengan resolusi mengikuti ukuran tile.

- CPU: ±4 vCPU per ~100 staf live sekaligus
- Bandwidth keluar server: ±(jumlah penonton × 12 tile × ~150 kbps)

Cek beban dengan `docker compose logs -f livekit`.
