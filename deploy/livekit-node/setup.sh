#!/usr/bin/env bash
# Menyiapkan server LiveKit (B) dari server Ubuntu baru yang masih kosong: pengamanan, LiveKit, rekorder, nginx + TLS.
# Panduan lengkap & urutan: docs/pindah-livekit.md
#
# Cara pakai (di server B, sebagai root atau dengan sudo):
#   cp node.env.example node.env && nano node.env
#   sudo bash setup.sh node.env
#
# Aman dijalankan ulang (idempoten): key LiveKit yang sudah ada tidak diganti, berkas yang sama ditulis ulang.
# Yang TIDAK dilakukan skrip ini: mengubah DNS, mengubah server A, memasang database/Redis/Node apa pun.
set -euo pipefail
umask 027

APP_USER="lacak"
APP_HOME="/home/${APP_USER}"
RECORDER_DIR="${APP_HOME}/recorder"
RECORDER_TMP="${APP_HOME}/rekaman-tmp"
CONF_DIR="/etc/livekit"
CONF_FILE="${CONF_DIR}/livekit.yaml"
KEYS_FILE="${CONF_DIR}/keys.env"
SNIPPET="${APP_HOME}/a-env-snippet.txt"
NGINX_SITE="/etc/nginx/sites-available/livekit"

log() { printf '\n==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die() { printf '\nGAGAL: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- validasi

is_ipv4() {
    local ip="$1" octet
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
    local IFS=.
    for octet in $ip; do ((10#$octet <= 255)) || return 1; done
}

is_private_ipv4() {
    is_ipv4 "$1" || return 1
    local a b
    IFS=. read -r a b _ _ <<<"$1"
    ((10#$a == 10)) && return 0
    ((10#$a == 172 && 10#$b >= 16 && 10#$b <= 31)) && return 0
    ((10#$a == 192 && 10#$b == 168)) && return 0
    return 1
}

is_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; }
is_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
is_email() { [[ "$1" =~ ^[^@\ ]+@[^@\ ]+\.[^@\ ]+$ ]]; }

validate_config() {
    local missing=()
    local name
    for name in DOMAIN_APP DOMAIN_LIVE EMAIL_CERTBOT A_PUBLIC_IP A_PRIVATE_IP B_PRIVATE_IP ADMIN_IP LIVEKIT_VERSION RECORDER_BINARY; do
        [[ -n "${!name:-}" ]] || missing+=("$name")
    done
    ((${#missing[@]} == 0)) || die "isi dulu di node.env: ${missing[*]}"

    is_domain "$DOMAIN_APP" || die "DOMAIN_APP tidak valid: $DOMAIN_APP"
    is_domain "$DOMAIN_LIVE" || die "DOMAIN_LIVE tidak valid: $DOMAIN_LIVE"
    is_email "$EMAIL_CERTBOT" || die "EMAIL_CERTBOT tidak valid"
    is_ipv4 "$A_PUBLIC_IP" || die "A_PUBLIC_IP bukan IPv4: $A_PUBLIC_IP"
    is_ipv4 "$ADMIN_IP" || die "ADMIN_IP bukan IPv4: $ADMIN_IP"
    is_private_ipv4 "$A_PRIVATE_IP" || die "A_PRIVATE_IP harus IP privat (10.x / 172.16-31.x / 192.168.x): $A_PRIVATE_IP"
    is_private_ipv4 "$B_PRIVATE_IP" || die "B_PRIVATE_IP harus IP privat (10.x / 172.16-31.x / 192.168.x): $B_PRIVATE_IP"
    is_version "$LIVEKIT_VERSION" || die "LIVEKIT_VERSION harus seperti 1.9.0 (tanpa 'v'): $LIVEKIT_VERSION"
    [[ "${HARDEN_SSH:-no}" == "yes" || "${HARDEN_SSH:-no}" == "no" ]] || die "HARDEN_SSH harus yes atau no"
}

# ---------------------------------------------------------------- berkas yang dihasilkan (ke stdout, bisa diuji)

render_livekit_yaml() {
    local key="$1" secret="$2"
    cat <<YAML
# Dibuat oleh deploy/livekit-node/setup.sh -- JANGAN di-commit, berisi secret.
port: 7880
bind_addresses:
  - "127.0.0.1"        # signaling hanya dari nginx di mesin ini
rtc:
  tcp_port: 7881
  udp_port: 7882-7889
  use_external_ip: true
  allow_tcp_fallback: false
  batch_io:
    batch_size: 128
    max_flush_interval: 2ms
keys:
  ${key}: ${secret}
room:
  empty_timeout: 300
  max_participants: 0
webhook:
  api_key: ${key}
  urls:
    - https://${DOMAIN_APP}/api/v1/livekit/webhook
logging:
  level: info
  pion_level: error
YAML
}

render_recorder_env() {
    local key="$1" secret="$2"
    cat <<ENV
LIVEKIT_API_KEY=${key}
LIVEKIT_API_SECRET=${secret}
RECORDER_LISTEN=${B_PRIVATE_IP}:7870
RECORDER_LIVEKIT_URL=ws://127.0.0.1:7880
RECORDER_WEBHOOK_URL=https://${DOMAIN_APP}/api/v1/livekit/webhook
RECORDER_TMP_DIR=${RECORDER_TMP}
RECORDER_FFMPEG=auto
RECORDER_SDK_LOG_LEVEL=warn
ENV
}

render_a_env_snippet() {
    local key="$1" secret="$2"
    cat <<ENV
LIVEKIT_URL=wss://${DOMAIN_LIVE}
LIVEKIT_API_KEY=${key}
LIVEKIT_API_SECRET=${secret}
RECORDER_URL=http://${B_PRIVATE_IP}:7870
ENV
}

render_unit_livekit() {
    cat <<UNIT
[Unit]
Description=LiveKit server (Live Kerja)
After=network-online.target
Wants=network-online.target

[Service]
User=${APP_USER}
Group=${APP_USER}
ExecStart=/usr/local/bin/livekit-server --config ${CONF_FILE}
Restart=always
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
}

render_unit_recorder() {
    cat <<UNIT
[Unit]
Description=Rekorder Live Kerja
After=network-online.target lacak-livekit.service
Wants=network-online.target

[Service]
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${RECORDER_DIR}
ExecStart=${RECORDER_DIR}/lacak-recorder -env ${RECORDER_DIR}/.env
Restart=always
RestartSec=3
# Berhenti dengan menyelesaikan & mengunggah rekaman yang sedang berjalan (sampai 90 detik).
KillSignal=SIGTERM
TimeoutStopSec=100
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${RECORDER_TMP}
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
}

# $1 = yes kalau sertifikat TLS sudah ada (blok 443 ikut ditulis)
render_nginx() {
    local has_cert="$1"
    cat <<'NGINX'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

NGINX
    cat <<NGINX
server {
    listen 80;
    server_name ${DOMAIN_LIVE};
    server_tokens off;
    location /.well-known/acme-challenge/ { root /var/www/html; }
NGINX
    if [[ "$has_cert" == "yes" ]]; then
        echo '    location / { return 301 https://$host$request_uri; }'
    else
        echo '    location / { return 503; }'
    fi
    echo '}'

    [[ "$has_cert" == "yes" ]] || return 0
    cat <<NGINX

server {
    listen 443 ssl;
    http2 on;
    server_name ${DOMAIN_LIVE};
    server_tokens off;

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN_LIVE}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN_LIVE}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # Admin API LiveKit: hanya backend di server A (dan tetap butuh JWT roomAdmin).
    location /twirp/ {
        allow ${A_PUBLIC_IP};
        deny all;
        proxy_pass http://127.0.0.1:7880;
        proxy_set_header Host \$host;
    }

    # Signaling WebSocket peserta (browser) & health check.
    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
}

# ---------------------------------------------------------------- langkah-langkah

step_checks() {
    [[ $EUID -eq 0 ]] || die "jalankan dengan sudo / sebagai root"
    [[ -r /etc/os-release ]] && . /etc/os-release
    [[ "${ID:-}" == "ubuntu" ]] || die "skrip ini untuk Ubuntu (terdeteksi: ${ID:-tidak diketahui})"
    [[ -f "$RECORDER_BINARY" && -x "$RECORDER_BINARY" ]] || die "RECORDER_BINARY tidak ada atau tidak executable: $RECORDER_BINARY (salin dari server A, lihat panduan bagian 5)"

    # Firewall hanya mengizinkan SSH dari ADMIN_IP: pastikan sesi sekarang tidak terkunci.
    local client="${SSH_CLIENT:-}"
    client="${client%% *}"
    [[ -n "$client" ]] || client="$(who -m 2>/dev/null | sed -n 's/.*(\(.*\)).*/\1/p')"
    if [[ -n "$client" && "$client" != "$ADMIN_IP" ]]; then
        die "Anda login dari $client, tapi ADMIN_IP=$ADMIN_IP. Firewall akan memutus sesi ini. Perbaiki ADMIN_IP di node.env."
    fi
}

step_packages() {
    log "Memasang paket sistem"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get upgrade -y
    apt-get install -y ufw fail2ban unattended-upgrades chrony nginx certbot curl ca-certificates openssl ffmpeg
    dpkg-reconfigure -f noninteractive unattended-upgrades
    systemctl enable --now chrony fail2ban
}

step_user() {
    log "Membuat pengguna ${APP_USER}"
    id "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$APP_USER"
    local keys="${APP_HOME}/.ssh/authorized_keys"
    if [[ ! -s "$keys" && -s /root/.ssh/authorized_keys ]]; then
        install -d -m 700 -o "$APP_USER" -g "$APP_USER" "${APP_HOME}/.ssh"
        install -m 600 -o "$APP_USER" -g "$APP_USER" /root/.ssh/authorized_keys "$keys"
    fi
    # Akun ini tanpa password: sudo-nya tanpa password juga (login hanya dengan kunci SSH).
    echo "${APP_USER} ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-${APP_USER}
    chmod 440 /etc/sudoers.d/90-${APP_USER}
    visudo -cf /etc/sudoers.d/90-${APP_USER} >/dev/null
}

step_ssh() {
    if [[ "${HARDEN_SSH:-no}" != "yes" ]]; then
        warn "HARDEN_SSH=no: login root & password SSH belum dimatikan. Setelah berhasil 'ssh ${APP_USER}@...', set HARDEN_SSH=yes lalu jalankan ulang."
        return 0
    fi
    [[ -s "${APP_HOME}/.ssh/authorized_keys" ]] || die "HARDEN_SSH=yes tapi ${APP_USER} belum punya kunci SSH (${APP_HOME}/.ssh/authorized_keys)"
    log "Mengunci SSH (hanya kunci, tanpa root)"
    # Nama berawalan 00- supaya menang atas 50-cloud-init.conf (nilai pertama yang dipakai sshd).
    cat >/etc/ssh/sshd_config.d/00-lacak-hardening.conf <<'SSH'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
SSH
    sshd -t
    systemctl reload ssh
}

step_kernel() {
    log "Buffer UDP kernel"
    printf 'net.core.rmem_max=5000000\nnet.core.wmem_max=5000000\n' >/etc/sysctl.d/90-livekit.conf
    sysctl --system >/dev/null
}

step_firewall() {
    log "Firewall (UFW)"
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow from "$ADMIN_IP" to any port 22 proto tcp comment 'SSH admin'
    ufw allow 80/tcp comment 'ACME + redirect'
    ufw allow 443/tcp comment 'LiveKit signaling (wss)'
    ufw allow 7881/tcp comment 'LiveKit media TCP'
    ufw allow 7882:7889/udp comment 'LiveKit media UDP'
    ufw allow from "$A_PRIVATE_IP" to any port 7870 proto tcp comment 'Rekorder dari backend A'
    ufw --force enable
    ufw status verbose
}

step_livekit() {
    log "Memasang LiveKit ${LIVEKIT_VERSION}"
    if command -v livekit-server >/dev/null 2>&1 && livekit-server --version 2>&1 | grep -q "$LIVEKIT_VERSION"; then
        echo "livekit-server ${LIVEKIT_VERSION} sudah terpasang."
        return 0
    fi
    local arch
    case "$(dpkg --print-architecture)" in
        amd64) arch=amd64 ;;
        arm64) arch=arm64 ;;
        *) die "arsitektur tidak didukung: $(dpkg --print-architecture)" ;;
    esac
    local base="https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}"
    local tarball="livekit_${LIVEKIT_VERSION}_linux_${arch}.tar.gz"
    local tmp
    tmp="$(mktemp -d)"
    (
        cd "$tmp"
        curl -fsSLO "${base}/${tarball}"
        curl -fsSLO "${base}/checksums.txt"
        grep " ${tarball}\$" checksums.txt >expected.txt || die "checksum ${tarball} tidak ada di checksums.txt"
        sha256sum -c expected.txt
        tar -xzf "$tarball" livekit-server
        install -m 0755 livekit-server /usr/local/bin/livekit-server
    )
    rm -rf "$tmp"
    livekit-server --version
}

step_config() {
    log "Konfigurasi LiveKit & rekorder"
    install -d -m 750 -o root -g "$APP_USER" "$CONF_DIR"

    local key secret
    if [[ -f "$KEYS_FILE" ]]; then
        # shellcheck disable=SC1090
        . "$KEYS_FILE"
        key="$LIVEKIT_API_KEY"
        secret="$LIVEKIT_API_SECRET"
        echo "Memakai API key yang sudah ada (${key})."
    else
        key="API$(openssl rand -hex 7)"
        secret="$(openssl rand -base64 64 | tr -d '\n+/=' | cut -c1-48)"
        [[ ${#secret} -ge 32 ]] || die "gagal membuat secret"
        printf 'LIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n' "$key" "$secret" >"$KEYS_FILE"
        chmod 600 "$KEYS_FILE"
    fi

    render_livekit_yaml "$key" "$secret" >"$CONF_FILE"
    chown root:"$APP_USER" "$CONF_FILE"
    chmod 640 "$CONF_FILE"

    install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$RECORDER_DIR" "$RECORDER_TMP"
    install -m 750 -o "$APP_USER" -g "$APP_USER" "$RECORDER_BINARY" "${RECORDER_DIR}/lacak-recorder"
    render_recorder_env "$key" "$secret" >"${RECORDER_DIR}/.env"
    chown "$APP_USER":"$APP_USER" "${RECORDER_DIR}/.env"
    chmod 600 "${RECORDER_DIR}/.env"

    render_a_env_snippet "$key" "$secret" >"$SNIPPET"
    chown "$APP_USER":"$APP_USER" "$SNIPPET"
    chmod 600 "$SNIPPET"
}

step_services() {
    log "Menjalankan LiveKit & rekorder (systemd)"
    render_unit_livekit >/etc/systemd/system/lacak-livekit.service
    render_unit_recorder >/etc/systemd/system/lacak-recorder.service
    systemctl daemon-reload
    systemctl enable lacak-livekit lacak-recorder
    systemctl restart lacak-livekit
    sleep 2
    systemctl restart lacak-recorder
    sleep 2
    systemctl is-active --quiet lacak-livekit || die "lacak-livekit tidak jalan: journalctl -u lacak-livekit -n 50"
    systemctl is-active --quiet lacak-recorder || die "lacak-recorder tidak jalan: journalctl -u lacak-recorder -n 50"

    curl -fsS --max-time 5 http://127.0.0.1:7880/ >/dev/null || die "LiveKit tidak menjawab di 127.0.0.1:7880"
    curl -fsS --max-time 5 "http://${B_PRIVATE_IP}:7870/health" >/dev/null || die "rekorder tidak menjawab di ${B_PRIVATE_IP}:7870"
    if ss -ltn 'sport = :7880' | grep -qE '(0\.0\.0\.0|\[::\]|\*):7880'; then
        die "port 7880 terbuka ke semua alamat -- seharusnya hanya 127.0.0.1"
    fi
    echo "OK: LiveKit hanya di 127.0.0.1:7880, rekorder di ${B_PRIVATE_IP}:7870."
}

step_tls() {
    log "nginx + sertifikat TLS untuk ${DOMAIN_LIVE}"
    rm -f /etc/nginx/sites-enabled/default
    ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/livekit
    install -d /var/www/html

    local cert="/etc/letsencrypt/live/${DOMAIN_LIVE}/fullchain.pem"
    local has_cert=no
    [[ -f "$cert" ]] && has_cert=yes
    render_nginx "$has_cert" >"$NGINX_SITE"
    nginx -t
    systemctl enable --now nginx
    systemctl reload nginx

    if [[ "$has_cert" == "no" ]]; then
        local my_ip dns_ip
        my_ip="$(curl -4fsS --max-time 8 https://ifconfig.me || true)"
        dns_ip="$(getent ahostsv4 "$DOMAIN_LIVE" | awk 'NR==1{print $1}' || true)"
        if [[ -z "$my_ip" || "$dns_ip" != "$my_ip" ]]; then
            warn "DNS ${DOMAIN_LIVE} -> '${dns_ip:-kosong}', IP server ini '${my_ip:-tidak terdeteksi}'. Sertifikat TLS DILEWATI."
            warn "Arahkan A-record ${DOMAIN_LIVE} ke IP publik server ini (DNS only), tunggu menyebar, lalu jalankan skrip ini lagi."
            return 0
        fi
        certbot certonly --webroot -w /var/www/html -d "$DOMAIN_LIVE" -m "$EMAIL_CERTBOT" --agree-tos --non-interactive
        has_cert=yes
        render_nginx yes >"$NGINX_SITE"
        nginx -t
    fi

    install -d /etc/letsencrypt/renewal-hooks/deploy
    printf '#!/bin/sh\nsystemctl reload nginx\n' >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    systemctl reload nginx
    certbot renew --dry-run
}

step_summary() {
    cat <<DONE

==========================================================================
 SERVER LIVEKIT SIAP
==========================================================================
 Nilai untuk server A sudah ditulis ke:  ${SNIPPET}
 (berisi key & secret BARU -- salin ke A lewat jaringan privat, lalu HAPUS berkas ini dari B)

   di server A:   scp ${APP_USER}@${B_PRIVATE_IP}:a-env-snippet.txt ~/a-env-snippet.txt
   di server B:   rm ${SNIPPET}

 Cek cepat:
   systemctl status lacak-livekit lacak-recorder --no-pager
   journalctl -u lacak-livekit -n 30 --no-pager
   curl -s http://${B_PRIVATE_IP}:7870/health
   curl -sI https://${DOMAIN_LIVE}/ | head -3
   sudo ufw status verbose

 Berikutnya: docs/pindah-livekit.md bagian 8 (uji) lalu bagian 9 (cutover).
==========================================================================
DONE
}

main() {
    local env_file="${1:-}"
    [[ -n "$env_file" && -f "$env_file" ]] || die "pakai: sudo bash setup.sh node.env"
    # shellcheck disable=SC1090
    set -a; . "$env_file"; set +a
    validate_config
    step_checks
    step_packages
    step_user
    step_kernel
    step_firewall
    step_livekit
    step_config
    step_services
    step_tls
    step_ssh
    step_summary
}

# LIB_ONLY=1: hanya memuat fungsi (untuk pengujian).
if [[ "${LIB_ONLY:-}" == "1" ]]; then
    return 0 2>/dev/null || exit 0
fi
main "$@"
