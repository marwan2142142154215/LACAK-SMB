# lacak-server.exe — kontrol panel server Lacak SMB

Aplikasi kecil (Python -> PyInstaller) untuk menyalakan, mematikan, dan
memantau log empat layanan dari satu jendela GUI:

| Layanan | Proses | Port |
|---|---|---|
| Backend API | `php artisan serve` | 8010 |
| Realtime Gateway | `npm start` (AdonisJS) | 3333 |
| Web Dashboard | `npm run dev` (Vite) | 5173 |
| Telegram Bot | `npm start` | — |

## Cara pakai

1. `lacak-server.exe` (di akar repo) — double-click / jalankan dari CMD.
2. Tombol **Start** per layanan, atau **Mulai Semua**.
3. Log realtime tiap proses mengalir di panel bawah (warna per layanan).
4. **Matikan Semua** untuk mengelhentikan seluruh pohon proses.

Jika layanan sudah hidup (mis. backend sedang jalan dari sesi lain), titik
indikator berubah hijau karena dilakukan pendeteksian port. Tombol **Stop**
hanya menampilkan perubahan status untuk proses yang dijalankan di luar
panel; kendali penuh proses eksternal tetap di pengelolanya.

## Membangun ulang exe (setelah mengubah `lacak_server.py`)

```powershell
pip install pyinstaller
python -m PyInstaller --noconfirm --clean --onefile --windowed --name lacak-server lacak_server.py
# hasilnya dist\lacak-server.exe — salin ke akar repo jika perlu
```

## Struktur

- `lacak_server.py` — sumber GUI (tkinter, murni standar library, tanpa
  dependensi luar)
- `lacak-server.exe` (di root repo) — hasil build PyInstaller
- `dist/`, `build/`, `lacak-server.spec` — artefak build (di-gitignore)
