# Memindahkan LiveKit (+ rekorder) ke server sendiri

Tujuan: LiveKit (media Live Kerja) dan rekorder pindah dari server aplikasi ke **server baru (B)**. Server lama
(**A**) tetap menjalankan backend, gateway, bot, database, Redis, dan dashboard.

**Dua skrip sudah disiapkan, tinggal dijalankan:**

| Skrip | Dijalankan di | Fungsi |
|---|---|---|
| `deploy/livekit-node/setup.sh` | **B** (sekali) | mengamankan server, memasang LiveKit + rekorder + nginx + TLS |
| `deploy/livekit-cutover.sh` | **A** | `apply` (pindahkan), `rollback` (batalkan), `cleanup` (hapus yang lama) |

> **`deploy/deploy.sh` tetap hanya untuk server A** (backend, gateway, dashboard). Jangan dijalankan di B, dan B tidak
> perlu menyalin seluruh repo.

> Istilah: **A** = server sekarang (`lacak-live`), **B** = server LiveKit baru. `<DOMAIN_APP>` = `lacaklive.smbservice.xyz`,
> `<DOMAIN_LIVE>` = alamat LiveKit (mis. `live.smbservice.xyz`; cek `LIVEKIT_URL` di `.env` A sekarang).

## 0. Spesifikasi

- **B: 8 vCPU dedicated, 16 GB RAM, disk 200 GB+**, 1 Gbps, **satu datacenter dan satu VPC dengan A**, Ubuntu 24.04.
  Disk besar karena berkas rekaman sementara menumpuk sampai pemotongan jam (±100 GB saat 330 staf live).
- **A: tetap 4 vCPU.** Setelah LiveKit dan rekorder pindah, sisa beban A (backend, gateway, Postgres, nginx) sekitar 1,5
  inti dan ±3 GB RAM dari ±7,8 GB, jadi cukup longgar.

## 1. Peta komunikasi

| Dari -> Ke | Protokol / port | Dipagari oleh |
|---|---|---|
| Browser -> B | `wss://<DOMAIN_LIVE>` (443, nginx B) | token JWT 10 menit dari backend |
| Browser -> B (video) | UDP 7882-7889, TCP 7881 | DTLS-SRTP; room dikunci token |
| A backend -> B (admin API) | `https://<DOMAIN_LIVE>/twirp/...` | JWT `roomAdmin` **dan** nginx B hanya menerima IP publik A |
| A backend -> rekorder B | `http://B_PRIV:7870` (VPC) | firewall B hanya menerima IP privat A **dan** bearer JWT |
| B LiveKit/rekorder -> A (webhook) | `https://<DOMAIN_APP>/api/v1/livekit/webhook` | JWT bertanda tangan + hash isi |
| Rekorder -> LiveKit | `ws://127.0.0.1:7880` | satu mesin, tanpa jaringan |
| Rekorder -> Spaces | HTTPS | kredensial dikirim backend per permintaan, tidak disimpan di B |

Port 7880 LiveKit **tidak pernah dibuka ke luar** (hanya 127.0.0.1); rekorder hanya mendengar di IP privat B.

## 2. Persiapan

1. Buat server B (spesifikasi di atas), masukkan ke VPC yang sama dengan A. Catat `B_PUB` dan `B_PRIV`.
2. Di A catat: IP publik (`curl -4 ifconfig.me`), IP privat (`ip -4 addr`), versi LiveKit (`livekit-server --version`).
3. Catat IP kantor/rumah Anda (`curl -4 ifconfig.me` dari laptop): satu-satunya yang boleh SSH ke B.
4. **Cadangkan di A** (untuk rollback):
   ```bash
   mkdir -p ~/cadangan-livekit && chmod 700 ~/cadangan-livekit
   cp /etc/livekit/livekit.yaml ~/cadangan-livekit/ && cp ~/lacaklive/backend-adonis/.env ~/cadangan-livekit/backend.env.awal
   pm2 save
   ```
5. **DNS**: turunkan TTL alamat LiveKit jadi 60 detik sehari sebelumnya. Alamat itu nanti diarahkan ke `B_PUB` dengan
   **DNS only** (Cloudflare: awan abu-abu). Kalau alamatnya sama dengan yang dipakai A sekarang, **jangan ubah dulu**:
   pakai alamat sementara (mis. `live2.smbservice.xyz`) selama uji, dan pindahkan alamat lama saat cutover.
6. Pilih **jam cutover** (jam sepi/pergantian shift) dan umumkan ke staf: siaran terputus sebentar dan **layar harus
   dibagikan lagi dengan klik**. Bonus: 185 siaran lama yang tidak terlihat ikut pindah ke room baru.

## 3. Menyiapkan rekorder untuk B (di A)

Rekorder dibangun di A (Go sudah ada) lalu disalin ke B:

```bash
cd ~/lacaklive && git pull && cd recorder && go build -o lacak-recorder .
scp lacak-recorder root@B_PUB:/root/lacak-recorder      # sekali ini sebagai root; kunci SSH root dari panel penyedia
```

Salin juga skrip setup ke B:

```bash
scp -r ~/lacaklive/deploy/livekit-node root@B_PUB:/root/
```

## 4. Menjalankan setup di B

Login ke B (sebagai root atau dengan sudo), lalu:

```bash
cd /root/livekit-node
cp node.env.example node.env && nano node.env        # isi semua nilainya
sudo bash setup.sh node.env
```

Yang dilakukan skrip (urut, aman dijalankan ulang):

1. Memeriksa isian `node.env` (IP privat harus benar-benar privat, versi bukan `v1.9`, dst.) dan menolak jalan kalau ada
   yang salah. Menolak juga kalau **sesi SSH Anda bukan dari `ADMIN_IP`**, supaya firewall tidak memutus Anda.
2. Update sistem, pasang `ufw`, `fail2ban`, `unattended-upgrades`, `chrony` (jam sinkron), `nginx`, `certbot`, `ffmpeg`.
3. Membuat pengguna `lacak` (login kunci SSH saja).
4. Buffer UDP kernel; firewall UFW: hanya 22 dari `ADMIN_IP`, 80, 443, 7881/tcp, 7882-7889/udp, dan 7870 hanya dari IP
   privat A.
5. Memasang LiveKit **versi yang sama dengan A**, dengan verifikasi checksum SHA-256 dari rilis resmi.
6. Membuat **API key & secret baru** (acak), menulis `livekit.yaml` (hanya 127.0.0.1:7880), `.env` rekorder, dan
   berkas nilai untuk A (`/home/lacak/a-env-snippet.txt`).
7. Menjalankan LiveKit dan rekorder sebagai layanan **systemd** (mulai otomatis, restart bila mati, dikunci dengan
   `NoNewPrivileges`, `ProtectSystem=strict`), lalu memeriksa bahwa 7880 tidak terbuka ke luar.
8. nginx + sertifikat TLS Let's Encrypt (`/twirp/` hanya untuk IP publik A) dan pembaruan sertifikat otomatis.
   **Kalau DNS belum mengarah ke B, langkah TLS dilewati dengan peringatan**; setelah DNS siap jalankan ulang skrip.
9. Kalau `HARDEN_SSH=yes`: mematikan login root dan password SSH. **Biarkan `no` pada putaran pertama.** Buka terminal
   baru dan pastikan `ssh lacak@B_PUB` berhasil, baru ubah jadi `yes` dan jalankan ulang skrip.

Saat selesai, skrip mencetak langkah berikutnya. Salin nilai ke A (dari A, lewat jaringan privat):

```bash
scp lacak@B_PRIV:a-env-snippet.txt ~/a-env-snippet.txt
# lalu di B:  rm /home/lacak/a-env-snippet.txt
```

## 5. Menguji B sebelum cutover (produksi belum disentuh)

Di B:

```bash
systemctl status lacak-livekit lacak-recorder --no-pager     # keduanya active (running)
sudo ss -ltnp | grep -E ':7880|:7870'                        # 7880 = 127.0.0.1 ; 7870 = B_PRIV
sudo ufw status verbose
journalctl -u lacak-livekit -n 30 --no-pager
```

Dari A: `curl -s http://B_PRIV:7870/health` harus `{"ok":true,...}`.
Dari laptop: `https://<DOMAIN_LIVE>/` menampilkan `OK`; `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<DOMAIN_LIVE>/twirp/livekit.RoomService/ListRooms`
harus **403**; `B_PUB:7870` dan `B_PUB:7880` harus **tidak** terjangkau (timeout).

## 6. Cutover (jam sepi, ±15 menit)

Di A, dengan `a-env-snippet.txt` sudah ada:

```bash
cd ~/lacaklive && git pull
bash deploy/livekit-cutover.sh apply ~/a-env-snippet.txt
shred -u ~/a-env-snippet.txt
```

`apply` **memeriksa B lebih dulu** (alamat LiveKit dan `/health` rekorder); kalau B belum sehat, tidak ada yang diubah.
Kalau sehat: mencadangkan `.env`, mengganti hanya `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `RECORDER_URL`,
menghentikan LiveKit & rekorder lokal, dan me-restart backend (`lacak-api`, `-queue`, `-scheduler`).

Kalau Anda memakai alamat LiveKit sementara, sebelum `apply` ubah DNS alamat yang akan dipakai ke `B_PUB`
(sudah termasuk di `LIVEKIT_URL` pada snippet; pastikan sertifikat B terbit untuk alamat itu).

Uji asap (5-10 menit):
- `pm2 logs lacak-api --lines 40` tanpa galat LiveKit.
- Di B: `curl -s http://B_PRIV:7870/health` menunjukkan `recordings` naik begitu staf membagikan layar.
- Live Kerja "Semua site": staf yang sudah membagikan layar kembali muncul.
- `cd ~/lacaklive/backend-adonis/build && node ace live:rooms` menunjukkan **0 room lama** (di server LiveKit baru).
- Setelah satu jam: tabel `live_recordings` mendapat baris `completed`, dan satu berkas bisa diputar di halaman Rekaman.

### Rollback (kalau ada masalah serius dalam ±30 menit)

```bash
bash deploy/livekit-cutover.sh rollback
```

Mengembalikan `.env` terakhir yang dicadangkan, menyalakan lagi LiveKit & rekorder lokal, lalu me-restart backend.
Kalau DNS sempat dipindah, kembalikan ke IP A.

## 7. Menghapus yang lama di A (hanya setelah B stabil 1-2 hari)

**Jangan hapus sebelum rekaman jam-jam berikutnya terbukti jalan di B.**

```bash
bash deploy/livekit-cutover.sh cleanup
```

Skrip meminta Anda mengetik `HAPUS`, menolak jalan kalau `RECORDER_URL` belum menunjuk server baru, lalu menghapus:
proses pm2 `lacak-livekit` dan `lacak-recorder`, `/usr/local/bin/livekit-server`, `/etc/livekit`, binary rekorder,
`/tmp/lacak-recorder`, dan `sysctl` LiveKit. Sisanya manual (skrip mencetak daftarnya):
tutup port 7881/tcp dan 7882:7889/udp di UFW dan firewall panel A, hapus blok nginx alamat LiveKit lama kalau ada, dan
hapus `~/cadangan-livekit` setelah seminggu (berisi secret lama): `shred -u ~/cadangan-livekit/*`.

`deploy/deploy.sh` otomatis **tidak membangun rekorder** di A kalau `RECORDER_URL` menunjuk server lain. Biarkan Go
terpasang di A: rekorder tetap dibangun di A lalu disalin ke B.

## 8. Operasi sehari-hari di B

```bash
systemctl status lacak-livekit lacak-recorder --no-pager
journalctl -u lacak-livekit -f                       # log LiveKit
journalctl -u lacak-recorder -f                      # log rekorder ("rekaman tersimpan")
sudo systemctl restart lacak-livekit                 # memutus semua siaran (menyambung ulang sendiri)
sudo systemctl restart lacak-recorder                # memotong rekaman berjalan; jam sepi
```

- **Memperbarui rekorder:** di A `cd ~/lacaklive && git pull && cd recorder && go build -o lacak-recorder .`, lalu
  `scp lacak-recorder lacak@B_PRIV:/home/lacak/recorder/lacak-recorder.baru` dan di B
  `sudo install -m 750 -o lacak -g lacak /home/lacak/recorder/lacak-recorder.baru /home/lacak/recorder/lacak-recorder && sudo systemctl restart lacak-recorder`.
- **Memperbarui LiveKit:** ubah `LIVEKIT_VERSION` di `node.env`, jalankan `sudo bash setup.sh node.env` (key tidak diganti),
  lalu `sudo systemctl restart lacak-livekit` di jam sepi.
- **Patch OS:** `unattended-upgrades` memasang pembaruan keamanan; reboot sebulan sekali di jam sepi.
- **Memantau:** `htop`; beban CPU > 70% terus-menerus berarti saatnya menambah kapasitas.

## 9. Daftar periksa keamanan akhir

- [ ] SSH hanya kunci, root login mati (`HARDEN_SSH=yes`), hanya dari `ADMIN_IP`.
- [ ] `ufw status` di B: hanya 22 (admin), 80, 443, 7881/tcp, 7882-7889/udp, 7870 (hanya IP privat A). Firewall panel penyedia sama.
- [ ] 7880 hanya di 127.0.0.1; 7870 hanya di IP privat (`ss -ltnp`).
- [ ] API key & secret baru; tidak di repo/chat; `a-env-snippet.txt` sudah dihapus dari A **dan** B.
- [ ] `/twirp/` dari luar IP A menjawab 403.
- [ ] Jam A dan B sinkron (`timedatectl` -> `System clock synchronized: yes`).
- [ ] `certbot renew --dry-run` berhasil.
- [ ] Tidak ada layanan lain di B (database, Redis, panel web).
- [ ] Salinan `livekit.yaml` dan `.env` rekorder di password manager, bukan di repo.
