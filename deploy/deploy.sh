#!/usr/bin/env bash
# Deploy backend + dashboard di server produksi (satu perintah):  bash deploy/deploy.sh
#
# PENTING: `node ace build` menghapus lalu membuat ulang folder backend-adonis/build. Semua proses pm2
# backend (api, queue, scheduler) harus di-restart sesudahnya; kalau hanya lacak-api, worker queue
# (yang menjalankan build APK) masih memakai folder kerja lama yang sudah terhapus dan build APK
# gagal dengan "shell-init: error retrieving current directory".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Ambil kode terbaru"
cd "$ROOT" && git pull

echo "==> Backend: build"
cd "$ROOT/backend-adonis"
npm ci
node ace build
cp .env build/.env
(cd build && npm ci --omit=dev)

echo "==> Restart semua proses backend"
pm2 restart lacak-api lacak-api-queue lacak-api-scheduler --update-env

# Gateway realtime (status Live Kerja per room site + peran) harus ikut sama versi dengan backend.
echo "==> Gateway: build & restart"
cd "$ROOT/realtime-gateway"
npm ci
node ace build
cp .env build/.env
(cd build && npm ci --omit=dev)
pm2 restart lacak-gateway --update-env

# Rekorder Live Kerja (opsional): dibangun hanya kalau Go terpasang dan folder recorder/ ada.
if command -v go >/dev/null 2>&1 && [ -d "$ROOT/recorder" ]; then
    echo "==> Rekorder: build"
    (cd "$ROOT/recorder" && go build -o lacak-recorder .)
    if pm2 describe lacak-recorder >/dev/null 2>&1; then
        pm2 restart lacak-recorder --update-env
    else
        echo "    (belum terdaftar di pm2: pm2 start ecosystem.config.cjs --only lacak-recorder && pm2 save)"
    fi
fi

echo "==> Dashboard: build & salin"
cd "$ROOT/web-dashboard"
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/lacaklive/dashboard/

echo "Selesai. Migrasi database (kalau ada yang baru): jalankan 'node ace migration:run' sebelum restart."
