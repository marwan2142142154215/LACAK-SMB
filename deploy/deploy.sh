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

echo "==> Dashboard: build & salin"
cd "$ROOT/web-dashboard"
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/lacaklive/dashboard/

echo "Selesai. Migrasi database (kalau ada yang baru): jalankan 'node ace migration:run' sebelum restart."
