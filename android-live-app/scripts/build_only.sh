#!/bin/bash
# Build APK Live Kerja. Dipanggil oleh backend-api (App\Services\ApkBuilder)
# lewat WSL dengan argumen yang sama seperti APK Master -- APK Live
# universal, jadi kode/nama site & URL gateway diterima tapi tidak dipakai
# (siaran selalu ke site akun staf yang login). backend-api sendiri yang
# membaca file hasil build, menghitung checksum, dan menyimpannya.
set -e

SITE_CODE="${1:?SITE_CODE wajib diisi}"
GATEWAY_URL="${2:?GATEWAY_URL wajib diisi}"
SITE_NAME="${3:?SITE_NAME wajib diisi}"
VERSION="${4:-1.0.0}"
BACKEND_API_URL="${5:?BACKEND_API_URL wajib diisi}"

# Server: bisa diatur dari luar (mis. unit systemd); bawaan ~/android-sdk.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(which java)")")")}"

cd "$(dirname "$0")/.."

# bash: gradlew di repo tidak selalu punya bit executable (checkout di Linux).
bash ./gradlew assembleDebug --no-daemon \
    -PappVersionName="$VERSION" \
    -PbackendApiUrl="$BACKEND_API_URL"

APK_PATH="$(pwd)/app/build/outputs/apk/debug/app-debug.apk"

if [ ! -f "$APK_PATH" ]; then
    echo "APK tidak ditemukan di $APK_PATH" >&2
    exit 1
fi

echo "APK_PATH=$APK_PATH"
