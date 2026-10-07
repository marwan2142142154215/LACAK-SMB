#!/bin/bash
# Build APK pelacak yang KODE SITE-nya sudah ditanam saat build (bukan
# diketik staf saat pakai), lalu daftarkan ke backend-api supaya muncul di
# dashboard untuk didownload admin (menu APK Builds -> checksum dihitung
# server, dipakai gateway untuk menolak APK bajakan/duplikat).
#
# Pemakaian:
#   ./scripts/build-for-site.sh <SITE_CODE> <GATEWAY_URL> <SITE_NAME> \
#       <ORGANIZATION_ID> <VERSION> <BACKEND_API_URL> <ADMIN_BEARER_TOKEN>
#
# Contoh:
#   ./scripts/build-for-site.sh SITE-ZFMDROXE2Z https://gw.lacaksmbbot.com \
#       "LACAK SMB" 1 1.0.0 https://api.lacaksmbbot.com/api/v1 "1|xxxxx..."
#
# Catatan: APK yang dihasilkan masih debug-signed (belum ada keystore
# release terpisah) -- cukup untuk distribusi langsung/sideload ke staf
# sendiri (bukan Play Store), tapi SEBELUM rilis produksi sungguhan, buat
# keystore release terpisah (disimpan di luar repo, dibackup) sesuai
# checklist android-apk-pro.
set -e

SITE_CODE="${1:?SITE_CODE wajib diisi}"
GATEWAY_URL="${2:?GATEWAY_URL wajib diisi}"
SITE_NAME="${3:?SITE_NAME wajib diisi}"
ORGANIZATION_ID="${4:?ORGANIZATION_ID wajib diisi}"
VERSION="${5:-1.0.0}"
BACKEND_API_URL="${6:?BACKEND_API_URL wajib diisi, contoh http://127.0.0.1:8010/api/v1}"
ADMIN_TOKEN="${7:?ADMIN_BEARER_TOKEN wajib diisi (token dari dashboard login admin)}"

export ANDROID_HOME="$HOME/android-sdk"
export JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))

cd "$(dirname "$0")/.."

echo "=== Building APK untuk site: $SITE_NAME ($SITE_CODE) v$VERSION ==="
./gradlew assembleDebug --no-daemon \
    -PsiteCode="$SITE_CODE" \
    -PgatewayUrl="$GATEWAY_URL" \
    -PsiteName="$SITE_NAME" \
    -PappVersionName="$VERSION"

APK_PATH="app/build/outputs/apk/debug/app-debug.apk"

if [ ! -f "$APK_PATH" ]; then
    echo "APK tidak ditemukan di $APK_PATH" >&2
    exit 1
fi

CHECKSUM=$(sha256sum "$APK_PATH" | cut -d' ' -f1)
echo "=== Checksum lokal (hanya untuk referensi; server menghitung ulang): $CHECKSUM ==="

echo "=== Mengunggah ke backend-api (organization_id=$ORGANIZATION_ID) ==="
curl -sS -X POST "$BACKEND_API_URL/apk-builds" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -F "organization_id=$ORGANIZATION_ID" \
    -F "version=$VERSION" \
    -F "apk_file=@$APK_PATH;type=application/vnd.android.package-archive"

echo
echo "=== DONE: APK untuk $SITE_NAME terdaftar di dashboard (menu APK Builds) ==="
