#!/bin/bash
# Build APK master dengan kode site ditanam saat build. Dipanggil oleh
# backend-api (App\Services\ApkBuilder) lewat WSL -- backend-api sendiri
# yang membaca file hasil build, menghitung checksum, dan menyimpannya.
set -e

SITE_CODE="${1:?SITE_CODE wajib diisi}"
GATEWAY_URL="${2:?GATEWAY_URL wajib diisi}"
SITE_NAME="${3:?SITE_NAME wajib diisi}"
VERSION="${4:-1.0.0}"
BACKEND_API_URL="${5:?BACKEND_API_URL wajib diisi}"

export ANDROID_HOME="$HOME/android-sdk"
export JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))

cd "$(dirname "$0")/.."

./gradlew assembleDebug --no-daemon \
    -PsiteCode="$SITE_CODE" \
    -PgatewayUrl="$GATEWAY_URL" \
    -PsiteName="$SITE_NAME" \
    -PappVersionName="$VERSION" \
    -PbackendApiUrl="$BACKEND_API_URL"

APK_PATH="$(pwd)/app/build/outputs/apk/debug/app-debug.apk"

if [ ! -f "$APK_PATH" ]; then
    echo "APK tidak ditemukan di $APK_PATH" >&2
    exit 1
fi

echo "APK_PATH=$APK_PATH"
