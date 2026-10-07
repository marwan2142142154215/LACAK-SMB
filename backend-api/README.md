# Lacak Master API

Backend API untuk sistem MDM (Mobile Device Management) legal: pelacakan
aset/kendaraan perusahaan, parental control untuk anak di bawah umur, dan
Find My Device — dipakai bersama oleh web dashboard, APK master, dan
jembatan bot Telegram. Setiap device wajib terkait dokumen consent yang
sudah ditandatangani (surat orang tua / surat persetujuan staf) sebelum
bisa dikelola.

## Teknologi
- PHP 8.3
- Laravel 13.35
- PostgreSQL 18 (lihat catatan WSL di bawah)
- Redis (cache & antrean non-transaksional)

## Library utama
- laravel/sanctum          : autentikasi API berbasis Bearer token
- spatie/laravel-permission: role & permission (super_admin, site_admin, parent, staff_viewer)
- spatie/laravel-activitylog: jejak perubahan data (audit siapa lock/unlock device)
- pragmarx/google2fa-laravel + bacon/bacon-qr-code: 2FA wajib + QR enrollment
- maatwebsite/excel        : ekspor/impor Excel
- barryvdh/laravel-dompdf  : cetak laporan PDF
- laravel/boost            : panduan AI-assisted development untuk proyek ini

## Catatan lingkungan lokal (Windows)
PostgreSQL & Redis dijalankan di **WSL2 (Ubuntu)**, bukan native Windows,
karena Application Control Policy (Smart App Control / WDAC) di perangkat
ini memblokir eksekusi biner PostgreSQL native. WSL2 meneruskan port
`5432` dan `6379` otomatis ke `127.0.0.1` sisi Windows, jadi `.env` cukup
mengarah ke `127.0.0.1` seperti biasa.

Menyalakan service tiap kali PC restart (dari dalam `wsl -d Ubuntu`):
```bash
sudo service postgresql start
sudo service redis-server start
```

## Cara menjalankan di local
1. `composer install`
2. Salin `.env.example` menjadi `.env`, sesuaikan `DB_*` dan `REDIS_*`
3. `php artisan key:generate`
4. `php artisan migrate --seed`
   - Seed membuat role (`super_admin`, `site_admin`, `parent`, `staff_viewer`)
     dan akun awal `marwanmaster` (super_admin, 2FA belum di-setup —
     login pertama akan memaksa alur scan QR).
5. `php artisan serve`

## Alur login (dipakai semua klien: dashboard, APK master, bot Telegram)
1. `POST /api/v1/auth/login` `{ username, password }`
   - Login pertama kali → balasan berisi `qr_code_svg` + `setup_token` untuk scan 2FA.
   - Login berikutnya → balasan berisi `challenge_token`, tinggal kirim kode 2FA.
2. `POST /api/v1/auth/2fa/setup/confirm` `{ setup_token, code }` (hanya sekali, saat enrollment)
3. `POST /api/v1/auth/2fa/verify` `{ challenge_token, code }`
4. Simpan `access_token` dari balasan, kirim sebagai `Authorization: Bearer <token>`.
5. `POST /api/v1/auth/logout` untuk mencabut token.

## Penanggung jawab
- Tim            : Internal
- Developer      : Marwan (dengan Claude Code)
- Divisi pengguna: Pemilik sistem (aset perusahaan / parental control)

## Tautan terkait
- Skema database   : [../docs/skema-database.md](../docs/skema-database.md)
- Alamat staging    : (belum ada)
- Alamat production : (belum ada)
