# LACAK-SMB — Agen Pelacak Windows

Agen pemantauan **aset PC milik perusahaan**, versi Windows dari aplikasi
pelacak Android. Memakai protokol yang sama: klaim rahasia device lewat
backend-api, lalu koneksi Socket.IO ke realtime-gateway namespace `/device`.

## Ruang lingkup (disengaja terbatas)

Agen ini **kasat mata** (ada ikon tray) dan **tunduk pada consent** yang
ditegakkan server — device tanpa dokumen persetujuan aktif tetap ditolak
gateway, sama seperti device Android.

Yang dikumpulkan dan dikirim (`device:status_report`, lihat
[`../docs/kontrak-status-perangkat.md`](../docs/kontrak-status-perangkat.md)):

- Baterai & daya (persen, sedang dicas).
- Jaringan (Wi-Fi/ethernet/none).
- Info PC: merek/model, versi Windows, penyimpanan, RAM, lama nyala.
- Lama layar **aktif** per hari (dari waktu idle input + status terkunci).
- Nama aplikasi yang sedang di depan dan **durasinya** per hari.

Yang **tidak** dikumpulkan: ketikan, tangkapan layar, judul jendela, isi
aplikasi/chat/email, kamera, mikrofon. Agen ini alat manajemen aset, bukan
alat penyadapan, dan **hanya boleh dipasang di perangkat milik perusahaan
dengan pemberitahuan ke pemakainya**.

## Jalankan dari sumber (untuk pengembangan)

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy config.example.json config.json   # lalu isi site_code & URL
pythonw main.py
```

`pythonw` dipakai agar tanpa jendela konsol. Ikon tray akan muncul; klik kanan
untuk melihat status, ID device, dan pemberitahuan pemantauan.

## Cara pakai

1. Jalankan agen di PC target. Saat pertama kali, agen membuat **ID Device**
   dan statusnya menjadi "Menunggu admin mendaftarkan device ini".
2. Admin membuka dashboard → Devices → daftarkan device baru memakai ID itu
   (salin lewat menu tray → "Salin ID Device").
3. Agen otomatis mengklaim rahasianya dan berganti ke "Aktif dipantau".
4. "Jalan otomatis saat login" aktif secara bawaan (entri HKCU Run, terlihat di
   Task Manager → Startup; bukan layanan tersembunyi).

Bila admin menekan **Daftar Ulang** di dashboard, rahasia lama ditolak gateway,
agen menghapus rahasia lokalnya dan mengklaim ulang sendiri.

## Build jadi .exe

```bash
pip install pyinstaller
pyinstaller --noconsole --onefile --name LacakSMBAgent main.py
```

Taruh `config.json` di folder yang sama dengan `LacakSMBAgent.exe`.

## Catatan integrasi

- `device:status_report` diterima gateway hanya setelah **ingestion sisi
  gateway/backend dibangun** (lihat kontrak data). Sebelum itu, agen tetap
  tercatat online lewat `device:hello`, tetapi detail status belum tersimpan.
- Library yang dipakai (`python-socketio`, `requests`, `psutil`, `pystray`,
  `Pillow`) di luar daftar library resmi perusahaan — perlu persetujuan karena
  standar tidak mencakup agen desktop Python.
