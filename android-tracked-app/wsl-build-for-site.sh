#!/bin/bash
set -e
# Token admin TIDAK boleh ditulis di sini (repo publik) -- isi lewat env:
#   LACAK_ADMIN_TOKEN=... ./wsl-build-for-site.sh
cd "$(dirname "$0")"
./scripts/build-for-site.sh "SITE-BIRLXDXZCG" "http://127.0.0.1:3333" "LACAK SMB" "1" "1.0.0" "http://127.0.0.1:8010/api/v1" "${LACAK_ADMIN_TOKEN:?LACAK_ADMIN_TOKEN wajib diisi}"
