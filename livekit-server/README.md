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
LIVEKIT_URL=wss://live.salahmu.fun
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

## ⚠️ Port & jaringan (penting)

| Port | Protokol | Untuk |
|---|---|---|
| 7880 | TCP (WebSocket) | signaling — boleh lewat Cloudflare Tunnel / reverse proxy TLS sebagai `wss://live.salahmu.fun` |
| 7882-7889 | **UDP** | video — **harus** terbuka langsung ke internet (IP publik) |
| 7881 | TCP | cadangan video kalau UDP diblokir jaringan |

**Cloudflare Tunnel tidak bisa meneruskan UDP/WebRTC.** Signaling (7880)
boleh lewat tunnel seperti backend-api & gateway, tetapi port 7881 dan
7882-7889 wajib bisa dijangkau langsung di IP publik server (buka di
firewall VPS). Tanpa itu staf bisa "terhubung" tapi videonya tidak pernah
muncul.

## Hemat CPU

- `udp_port: 7882-7889` (bukan satu port): tiap port punya socket sendiri,
  jadi paket dibaca paralel di semua core. Rentang minimal = jumlah vCPU.
- `batch_io`: paket keluar dikirim berkelompok, system call jauh berkurang.
- Buffer UDP kernel diperbesar supaya paket video tidak dibuang saat ramai
  (dibuang = penonton minta kirim ulang = CPU terbuang):

```bash
echo -e 'net.core.rmem_max=5000000\nnet.core.wmem_max=5000000' | sudo tee /etc/sysctl.d/90-livekit.conf
sudo sysctl --system
```

## Kapasitas (perkiraan)

Tiap staf mengirim simulcast 180p + 360p (+540p saat ada yang menonton
layar besar). Penonton hanya mengunduh video yang tampil di halaman grid
(12 per halaman), dengan resolusi mengikuti ukuran tile.

- CPU: ±4 vCPU per ~100 staf live sekaligus
- Bandwidth keluar server: ±(jumlah penonton × 12 tile × ~150 kbps)

Cek beban dengan `docker compose logs -f livekit`.
