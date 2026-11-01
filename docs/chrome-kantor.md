# Chrome/Edge kantor untuk Live Kerja

Tombol **"Stop sharing"** milik browser tidak bisa disembunyikan oleh situs
web mana pun (aturan keamanan browser). Di laptop kantor yang Chrome/Edge-nya
diatur IT, Live Kerja bisa membuat tombol itu tidak berguna: begitu staf
menghentikan berbagi layar, dialog **bagikan layar dibuka lagi otomatis**
dalam ±3 detik dan diulang tiap 30 detik kalau dibatalkan. Selama itu
status staf SCREEN OFF, dashboard terkunci, notifikasi Windows muncul, dan
waktunya tidak dihitung sebagai jam kerja.

Tanpa kebijakan ini (Chrome biasa), browser menolak membuka dialog tanpa
klik, jadi staf harus menekan **Bagikan lagi** sendiri.

## Kebijakan yang dipasang

| Kebijakan | Nilai | Gunanya |
|---|---|---|
| `ScreenCaptureWithoutGestureAllowedForOrigins` | `https://lacaklive.smbservice.xyz` | Dialog bagikan layar dibuka ulang otomatis tanpa klik |
| `VideoCaptureAllowedUrls`, `AudioCaptureAllowedUrls` | `https://lacaklive.smbservice.xyz` | Kamera & mikrofon tidak bisa diblokir staf |
| `NotificationsAllowedForUrls` | `https://lacaklive.smbservice.xyz` | Notifikasi "layar tidak dibagikan" selalu muncul |
| `IncognitoModeAvailability` (Edge: `InPrivateModeAvailability`) | `1` | Mode penyamaran dimatikan |
| `DeveloperToolsAvailability` | `2` | DevTools dimatikan |

Kebijakan didukung Chrome 116+ dan Edge 123+ di Windows.

## Cara memasang

**Satu laptop (disarankan):** salin folder `deploy/chrome-kantor` (atau isi
`Live-Kerja-Chrome-Edge.zip`) ke laptop, klik dua kali
**`Pasang-Live-Kerja.bat`**, pilih *Yes* saat diminta izin Administrator,
lalu tutup & buka lagi Chrome/Edge (installer menawarkan menutupkannya).
Installer menambah alamat Live Kerja ke tiap daftar kebijakan **tanpa
menimpa** entri lain dari IT, dan aman dijalankan berulang.
Menghapus: klik dua kali **`Hapus-Live-Kerja.bat`** -- hanya entri Live
Kerja yang dibuang.

Alamat lain (mis. server uji): `powershell -ExecutionPolicy Bypass -File
live-kerja-browser.ps1 -Url https://alamat-lain` sebagai Administrator.

**Cara lama:** klik kanan `lacak-chrome-edge.reg` → *Merge* (sebagai
Administrator). File ini menimpa entri `"1"` di tiap daftar, jadi aturan IT
lain di posisi itu bisa hilang -- pakai installer bila memungkinkan.

**Banyak laptop (domain):** Group Policy → *Computer Configuration →
Administrative Templates → Google → Google Chrome* (template ADMX Chrome) /
*Microsoft Edge*, isi kebijakan di tabel di atas, lalu `gpupdate /force`.

**Cek:** buka `chrome://policy` (Edge: `edge://policy`), tekan *Reload
policies*; kebijakan di atas harus tampil dengan status OK.

**Uji:** staf Mulai kerja → tekan "Stop sharing" di bilah Chrome → dalam ±3
detik dialog bagikan layar muncul sendiri.

## Opsional: tanpa dialog sama sekali

Chrome punya saklar baris perintah (untuk pengujian, tidak resmi didukung)
yang memilih sumber layar otomatis tanpa menampilkan dialog. Buat shortcut
khusus Live Kerja dengan target:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --auto-select-desktop-capture-source="Entire screen" https://lacaklive.smbservice.xyz/live
```

Nilainya harus sama dengan nama sumber di dialog Chrome, yang mengikuti
bahasa Chrome (mis. `Seluruh layar` untuk Chrome berbahasa Indonesia, atau
`Screen 1` untuk lebih dari satu monitor). Uji dulu di satu laptop.

## Batasannya

- Hanya berlaku di Chrome/Edge yang diatur kebijakan ini. Staf yang memakai
  browser lain atau laptop pribadi tetap harus menekan Bagikan lagi --
  sebaiknya Live Kerja hanya boleh dari laptop kantor.
- Staf tetap bisa menutup Chrome. Itu tercatat: status DISCONNECTED lalu
  sesi ditutup, dan jam kerja berhenti dihitung.
