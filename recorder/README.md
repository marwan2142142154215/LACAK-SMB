# Rekorder Live Kerja (tanpa Docker)

Program Go kecil yang menggantikan LiveKit Egress untuk **rekaman track staf**. Ia masuk ke room `site-*` sebagai
penonton tersembunyi, menulis paket video **VP8 apa adanya** (tanpa transcoding, tanpa GStreamer, tanpa Chrome) ke
berkas WebM dengan cap waktu asli, mengunggahnya ke DigitalOcean Spaces, lalu melapor ke backend.

```
staf ──VP8──> LiveKit ──track_published (webhook)──> backend
                 │                                      │ StartTrackEgress / StopEgress
                 └──paket RTP──> rekorder <─────────────┘ (http://127.0.0.1:7870, bertoken)
                                    │ unggah .webm
                                    ▼
                              Spaces (privat)  ── egress_ended (webhook bertanda tangan) ──> backend
```

Backend tidak berubah alurnya: ia memanggil `StartTrackEgress` / `StopEgress` seperti ke Egress resmi, hanya ke
alamat `RECORDER_URL`. Pemotongan per jam, masa simpan 72 jam, dan halaman Rekaman tetap yang lama.

## Kebutuhan

- Go **1.27.3** di server (hanya untuk membangun; binary hasilnya berdiri sendiri).
- `ffmpeg` (opsional, disarankan): memperbaiki durasi & penunjuk geser di berkas WebM dengan `-c copy` (hampir tanpa CPU).
- Staf menyiarkan **VP8** (bawaan `livekit-client` di Chrome/Edge). Codec lain (H.264/AV1) ditolak dengan galat yang jelas.

## Pasang di server

```bash
# 1) Go (sekali saja)
curl -fsSLO https://go.dev/dl/go1.27.3.linux-amd64.tar.gz
echo "CEK SHA256 di https://go.dev/dl/ lalu cocokkan dengan: sha256sum go1.27.3.linux-amd64.tar.gz"
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.27.3.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin   # tambahkan juga ke ~/.profile

# 2) Bangun
cd ~/lacaklive/recorder && go build -o lacak-recorder .

# 3) (opsional) ffmpeg
sudo apt-get install -y ffmpeg
```

### LiveKit: webhook (WAJIB)

Backend tahu ada track baru dari webhook LiveKit. Tambahkan di `/etc/livekit/livekit.yaml` (key sama dengan blok `keys:`):

```yaml
webhook:
  api_key: NAMA_API_KEY_ANDA
  urls:
    - http://127.0.0.1:7564/api/v1/livekit/webhook
```

Lalu `pm2 restart lacak-livekit`. Redis **tidak** diperlukan.

### Backend `.env`

```
RECORDER_URL=http://127.0.0.1:7870
# Disarankan mulai dari layar saja (lihat "Ukuran data" di bawah):
RECORDING_SOURCES=screen_share
```

`pm2 restart lacak-api --update-env` (DO_SPACES_* dan LIVEKIT_API_* yang sudah ada dipakai apa adanya).

### Jalankan lewat pm2

Rekorder membaca key LiveKit dari `.env` backend (`-env ../backend-adonis/.env`); ia tidak punya kredensial Spaces sendiri
(backend mengirim tujuan unggah di tiap permintaan).

```bash
cd ~/lacaklive
pm2 start ecosystem.config.cjs --only lacak-recorder   # entri muncul otomatis setelah binary ada
pm2 save
curl -s http://127.0.0.1:7870/health                    # {"ok":true,"recordings":0,"rooms":0}
```

Variabel opsional (env atau `.env`): `RECORDER_LISTEN` (harus loopback), `RECORDER_LIVEKIT_URL` (bawaan `ws://127.0.0.1:7880`),
`RECORDER_WEBHOOK_URL` (bawaan `http://127.0.0.1:7564/api/v1/livekit/webhook`), `RECORDER_TMP_DIR`,
`RECORDER_FFMPEG` (`auto` = pakai ffmpeg kalau ada).

## Uji dengan 2-3 staf dulu

1. Satu staf menekan **Mulai kerja**. Dalam beberapa detik: `curl -s http://127.0.0.1:7870/health` menunjukkan `recordings` ≥ 1,
   dan `pm2 logs lacak-recorder` mencatat "rekorder masuk ke room".
2. Tunggu jam penuh berlalu (atau uji cepat: staf menekan **Selesai kerja** setelah beberapa menit).
3. Di halaman **Rekaman**, pilih staf dan tanggalnya: berkas muncul dan bisa diputar. Cek juga kecepatan putar dan geser.
4. Cek di Spaces: `lacaklive/recordings/{site}/{staf}/{tanggal}/...webm` bersifat privat.
5. Pantau `top`/`pm2 monit` selama beberapa jam sebelum menambah jumlah staf.

## Ukuran data (baca sebelum menyalakan untuk semua staf)

Perkiraan kasar untuk VP8 (aktual bergantung isi layar dan jaringan): kamera 720p ±0,5-1 GB/jam, layar 1080p/15fps ±0,2-0,4 GB/jam
per staf. Untuk ±130 staf yang siaran bersamaan:

- layar saja: ±25-50 GB per jam siaran, ±2-4 TB untuk masa simpan 72 jam;
- kamera + layar: beberapa kali lipatnya.

Mulai dari `RECORDING_SOURCES=screen_share`, ukur ukuran file sebenarnya dari uji coba, lalu hitung biaya Spaces dan
bandwidth unggah server sebelum memperluas.

## Batasan yang perlu diketahui

- **Hanya VP8, hanya video** (tanpa audio), satu berkas per track per jam.
- **Celah beberapa detik di pergantian jam**: rekaman lama ditutup, yang baru menunggu keyframe berikutnya.
- **Laporan "selesai" dikirim sebelum unggahan selesai** supaya pergantian jam tidak menahan rekaman berikutnya. Kalau unggahan
  gagal, laporan kedua menandai berkas itu gagal. Berkas jam terakhir baru bisa diputar setelah unggahannya selesai.
- Rekorder di-restart di tengah jalan: rekaman yang berjalan diselesaikan dan diunggah dulu (hingga 90 detik); sisanya yang
  hilang akan dianggap selesai oleh backend pada pergantian jam berikutnya dan rekaman baru dimulai.
- Resolusi dikunci ke kualitas tertinggi (simulcast) supaya tidak berganti di tengah berkas, jadi bandwidth LiveKit → rekorder
  setara satu penonton ber-kualitas penuh per track.
- Kode ini baru diuji dengan tes unit (tanda tangan, penulisan WebM, validasi) dan kompilasi; **belum diuji terhadap server
  LiveKit sungguhan**. Itulah gunanya uji dengan 2-3 staf di atas.

## Pengembangan

```bash
go vet ./... && go test ./...
GOOS=linux GOARCH=amd64 go build -o lacak-recorder .
```
