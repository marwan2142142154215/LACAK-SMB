#!/bin/bash
# Build APK master dengan kode site ditanam saat build. Dipanggil oleh
# backend-adonis (app/services/ApkBuilder.ts) -- backend-adonis sendiri
# yang membaca file hasil build, menghitung checksum, dan menyimpannya.
set -e

SITE_CODE="${1:?SITE_CODE wajib diisi}"
GATEWAY_URL="${2:?GATEWAY_URL wajib diisi}"
SITE_NAME="${3:?SITE_NAME wajib diisi}"
VERSION="${4:-1.0.0}"
BACKEND_API_URL="${5:?BACKEND_API_URL wajib diisi}"

# Server: bisa diatur dari luar (mis. unit systemd); bawaan ~/android-sdk.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
# JAVA_HOME: pakai yang diset dari luar kalau valid; kalau tidak, turunkan dari `java` di PATH.
# (Dulu: tanpa java di server, `which java` kosong dan JAVA_HOME jadi "." -> Gradle gagal membingungkan.)
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
    JAVA_BIN="$(command -v java || true)"
    if [ -z "$JAVA_BIN" ]; then
        echo "ERROR: JDK tidak ditemukan di server ini. Pasang JDK 17: sudo apt-get install -y openjdk-17-jdk-headless" >&2
        exit 1
    fi
    export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$JAVA_BIN")")")"
fi
if [ ! -d "$ANDROID_HOME" ]; then
    echo "ERROR: Android SDK tidak ditemukan di $ANDROID_HOME. Pasang SDK atau set ANDROID_HOME (lihat docs build APK di server)." >&2
    exit 1
fi

cd "$(dirname "$0")/.."

# bash: gradlew di repo tidak selalu punya bit executable (checkout di Linux).
bash ./gradlew assembleDebug --no-daemon \
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
