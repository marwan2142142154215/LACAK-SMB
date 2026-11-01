#!/usr/bin/env bash
# Pindah LiveKit ke server sendiri -- sisi SERVER APLIKASI (A). Panduan: docs/pindah-livekit.md
#
#   bash deploy/livekit-cutover.sh apply ~/a-env-snippet.txt   # arahkan backend ke server LiveKit baru
#   bash deploy/livekit-cutover.sh rollback                    # kembali ke LiveKit lokal (dalam ~30 menit pertama)
#   bash deploy/livekit-cutover.sh cleanup                     # hapus LiveKit & rekorder lokal (setelah B stabil 1-2 hari)
#
# apply : memeriksa B sehat, mencadangkan .env, mengganti 4 variabel LIVEKIT/RECORDER, menghentikan LiveKit &
#         rekorder lokal, lalu me-restart backend. Siaran staf terputus dan menyambung ulang sendiri (layar dibagikan lagi).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/backend-adonis/.env}"
# pm2 menjalankan backend dari folder build/ yang membaca build/.env (disalin oleh deploy.sh), bukan .env di atasnya.
BUILD_ENV_FILE="${BUILD_ENV_FILE:-$ROOT/backend-adonis/build/.env}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/cadangan-livekit}"
PM2="${PM2:-pm2}"
CURL="${CURL:-curl}"
MANAGED_KEYS=(LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET RECORDER_URL)

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nGAGAL: %s\n' "$*" >&2; exit 1; }

# Nilai hanya boleh huruf/angka dan . _ : / - (aman untuk sed, tanpa spasi/kutip/&/|).
safe_value() { [[ "$1" =~ ^[A-Za-z0-9._:/-]+$ ]]; }

# Baca KEY dari berkas KEY=VALUE (baris terakhir menang).
read_key() {
    local file="$1" key="$2"
    grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

# Ganti KEY=... kalau ada, kalau tidak tambahkan di akhir.
set_key() {
    local file="$1" key="$2" value="$3"
    if grep -qE "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    else
        printf '%s=%s\n' "$key" "$value" >>"$file"
    fi
}

validate_snippet() {
    local snippet="$1" key value
    [[ -f "$snippet" ]] || die "berkas tidak ada: $snippet"
    for key in "${MANAGED_KEYS[@]}"; do
        value="$(read_key "$snippet" "$key")"
        [[ -n "$value" ]] || die "$key kosong/tidak ada di $snippet"
        safe_value "$value" || die "$key berisi karakter yang tidak diizinkan"
    done
    [[ "$(read_key "$snippet" LIVEKIT_URL)" =~ ^wss://[A-Za-z0-9.-]+$ ]] || die "LIVEKIT_URL harus wss://domain"
    [[ "$(read_key "$snippet" RECORDER_URL)" =~ ^http://(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)[0-9.]+:7870$ ]] \
        || die "RECORDER_URL harus http://IP-privat:7870 (jaringan VPC), bukan IP publik"
    local secret
    secret="$(read_key "$snippet" LIVEKIT_API_SECRET)"
    ((${#secret} >= 32)) || die "LIVEKIT_API_SECRET minimal 32 karakter"
}

latest_backup() { ls -1t "$BACKUP_DIR"/backend.env.* 2>/dev/null | head -1 || true; }

# Salin .env ke build/.env supaya proses pm2 benar-benar memakai nilai baru.
sync_build_env() {
    local dir
    dir="$(dirname "$BUILD_ENV_FILE")"
    [[ -d "$dir" ]] || die "folder build backend tidak ada: $dir (jalankan deploy.sh dulu)"
    cp "$ENV_FILE" "$BUILD_ENV_FILE"
    chmod 600 "$BUILD_ENV_FILE"
}

restart_backend() {
    sync_build_env
    "$PM2" restart lacak-api lacak-api-queue lacak-api-scheduler --update-env
}

cmd_apply() {
    local snippet="${1:-}"
    [[ -n "$snippet" ]] || die "pakai: livekit-cutover.sh apply ~/a-env-snippet.txt"
    [[ -f "$ENV_FILE" ]] || die ".env backend tidak ditemukan: $ENV_FILE"
    validate_snippet "$snippet"

    local livekit_url recorder_url host
    livekit_url="$(read_key "$snippet" LIVEKIT_URL)"
    recorder_url="$(read_key "$snippet" RECORDER_URL)"
    host="${livekit_url#wss://}"

    log "Memeriksa server LiveKit baru (sebelum menyentuh apa pun)"
    "$CURL" -fsS --max-time 8 "https://${host}/" >/dev/null || die "https://${host}/ tidak menjawab -- LiveKit baru belum siap, tidak ada yang diubah"
    "$CURL" -fsS --max-time 8 "${recorder_url}/health" >/dev/null || die "${recorder_url}/health tidak menjawab -- rekorder baru belum siap, tidak ada yang diubah"

    log "Mencadangkan .env"
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR"
    local backup="$BACKUP_DIR/backend.env.$(date +%Y%m%d-%H%M%S)"
    cp "$ENV_FILE" "$backup"
    chmod 600 "$backup"
    echo "Cadangan: $backup"

    log "Mengganti variabel LiveKit & rekorder di .env"
    local key
    for key in "${MANAGED_KEYS[@]}"; do
        set_key "$ENV_FILE" "$key" "$(read_key "$snippet" "$key")"
    done

    log "Menghentikan LiveKit & rekorder lokal, me-restart backend"
    "$PM2" stop lacak-recorder lacak-livekit 2>/dev/null || true
    restart_backend

    cat <<DONE

Selesai. Staf menyambung ulang ke ${livekit_url} dalam 5-25 detik (layar perlu dibagikan lagi).
Pantau:  pm2 logs lacak-api --lines 40      |  di B: journalctl -u lacak-livekit -n 40 --no-pager
Kalau bermasalah:  bash deploy/livekit-cutover.sh rollback
Setelah ${snippet} dipakai, HAPUS berkas itu (berisi secret):  shred -u ${snippet}
DONE
}

cmd_rollback() {
    local backup
    backup="$(latest_backup)"
    [[ -n "$backup" ]] || die "tidak ada cadangan di $BACKUP_DIR"
    log "Mengembalikan $backup"
    cp "$ENV_FILE" "$ENV_FILE.sebelum-rollback"
    cp "$backup" "$ENV_FILE"
    "$PM2" start lacak-livekit lacak-recorder
    restart_backend
    echo
    echo "Kembali ke LiveKit lokal. Kalau DNS LiveKit sempat dipindah, kembalikan ke IP server ini."
}

cmd_cleanup() {
    log "Hapus LiveKit & rekorder LOKAL di server ini"
    echo "Jalankan HANYA setelah server LiveKit baru stabil 1-2 hari dan rekaman terbukti jalan."
    local url
    url="$(read_key "$ENV_FILE" LIVEKIT_URL)"
    echo "LIVEKIT_URL di .env sekarang: ${url:-kosong}"
    [[ "$(read_key "$ENV_FILE" RECORDER_URL)" =~ ^http://(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.) ]] \
        || die "RECORDER_URL belum menunjuk server baru -- jangan hapus apa pun"
    printf 'Ketik HAPUS untuk melanjutkan: '
    local answer
    read -r answer
    [[ "$answer" == "HAPUS" ]] || die "dibatalkan"

    "$PM2" delete lacak-livekit lacak-recorder 2>/dev/null || true
    "$PM2" save
    sudo rm -f /usr/local/bin/livekit-server
    sudo rm -rf /etc/livekit
    rm -f "$ROOT/recorder/lacak-recorder"
    rm -rf /tmp/lacak-recorder
    sudo rm -f /etc/sysctl.d/90-livekit.conf
    sudo sysctl --system >/dev/null
    cat <<'DONE'

Selesai. Sisanya dikerjakan manual (lihat docs/pindah-livekit.md bagian 10):
  - tutup port di firewall:  sudo ufw status numbered  lalu hapus aturan 7881/tcp dan 7882:7889/udp
  - hapus blok nginx alamat LiveKit lama di server ini kalau ada, lalu: sudo nginx -t && sudo systemctl reload nginx
  - hapus cadangan lama yang berisi secret setelah seminggu:  shred -u ~/cadangan-livekit/*
DONE
}

# LIB_ONLY=1: hanya memuat fungsi (untuk pengujian).
if [[ "${LIB_ONLY:-}" == "1" ]]; then
    return 0 2>/dev/null || exit 0
fi

case "${1:-}" in
    apply) shift; cmd_apply "$@" ;;
    rollback) cmd_rollback ;;
    cleanup) cmd_cleanup ;;
    *) die "pakai: livekit-cutover.sh apply <berkas> | rollback | cleanup" ;;
esac
