#!/bin/bash
# Build APK lewat WSL2 Ubuntu, dijalankan dari Windows dengan:
#   wsl -d Ubuntu -- bash "/mnt/c/path/ke/android-tracked-app/scripts/build-in-wsl.sh"
#
# Kenapa WSL: di sebagian environment Windows, Gradle gagal start karena
# java.nio.channels.Selector.open() butuh Unix Domain Socket untuk pipe
# internal, dan beberapa kebijakan keamanan Windows memblokirnya khusus
# untuk proses Java (bukan proses lain seperti PowerShell/curl). Kernel
# Linux WSL2 tidak kena restriksi yang sama. APK hasil build di sini tetap
# bisa di-install lewat `adb.exe` Windows biasa (USB tetap lewat Windows).
#
# Prasyarat satu kali di WSL (Ubuntu):
#   sudo apt install -y openjdk-17-jdk unzip
#   Android SDK command-line tools + platform-tools + platforms;android-36
#     + build-tools;36.0.0 terpasang di ~/android-sdk (lihat README)
#   Gradle 8.13 terpasang di ~/gradle-dist/gradle-8.13 (atau pakai ./gradlew
#     yang sudah di-generate di repo ini)
set -e

export ANDROID_HOME="$HOME/android-sdk"
export JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))

cd "$(dirname "$0")/.."

echo "=== Building debug APK ==="
./gradlew assembleDebug --no-daemon

echo "=== Running lint ==="
./gradlew lint --no-daemon

echo "=== APK output ==="
find app/build/outputs -name "*.apk"
echo "=== DONE ==="
