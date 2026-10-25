<?php

return [
    /*
    |--------------------------------------------------------------------
    | Build APK on-demand per site
    |--------------------------------------------------------------------
    | Path proyek Android di filesystem Windows (dipanggil lewat WSL2 --
    | lihat App\Services\ApkBuilder) dan URL publik yang ditanam ke dalam
    | APK supaya staf yang download bisa langsung pakai dari luar jaringan
    | lokal (lewat Cloudflare Tunnel), bukan cuma 127.0.0.1.
    */

    'tracker_project_path' => env('LACAKSMB_TRACKER_PROJECT_PATH', base_path('../android-tracked-app')),
    'master_project_path' => env('LACAKSMB_MASTER_PROJECT_PATH', base_path('../android-master-app')),
    // APK Live Kerja (siaran kamera staf yang tetap jalan di latar belakang).
    'live_project_path' => env('LACAKSMB_LIVE_PROJECT_PATH', base_path('../android-live-app')),

    'public_gateway_url' => env('LACAKSMB_PUBLIC_GATEWAY_URL', 'https://ws.salahmu.fun'),
    'public_backend_api_url' => env('LACAKSMB_PUBLIC_BACKEND_API_URL', 'https://api.salahmu.fun/api/v1'),

    // Nama distro WSL yang dipakai untuk build Gradle (lihat catatan proyek:
    // Gradle tidak bisa jalan langsung di Windows native di mesin ini).
    'wsl_distro' => env('LACAKSMB_WSL_DISTRO', 'Ubuntu'),

    // Cara menjalankan scripts/build_only.sh: 'bash' (server Linux, langsung)
    // atau 'wsl' (mesin build Windows). Bawaan mengikuti OS.
    'apk_build_runner' => env('LACAKSMB_APK_BUILD_RUNNER', PHP_OS_FAMILY === 'Windows' ? 'wsl' : 'bash'),

    // Tipe 'server' tidak perlu Gradle -- ApkBuilder cukup menyalin
    // lacak-server.exe yang sudah ter-build (server-gui).
    'server_exe_path' => env('LACAKSMB_SERVER_EXE_PATH', base_path('../lacak-server.exe')),

    /*
    |--------------------------------------------------------------------
    | Account Center (login terpusat)
    |--------------------------------------------------------------------
    | Login dengan email diverifikasi ke Account Center (lihat
    | App\Services\AccountCenter); 2FA tetap wajib sesudahnya. Kalau uri/
    | name/secret kosong, login jatuh ke password lokal. Nama variabelnya
    | sama dengan proyek scatter supaya kredensialnya bisa dipakai bersama.
    */
    'account_center' => [
        'enabled' => (bool) env('ACCOUNTCENTER_ENABLED', true),
        'uri' => env('ACCOUNTCENTER_URI', ''),
        'name' => env('ACCOUNTCENTER_NAME', ''),
        'secret' => env('ACCOUNTCENTER_SECRET', ''),
        'timeout_ms' => (int) env('ACCOUNTCENTER_TIMEOUT_MS', 8000),
    ],

    /*
    |--------------------------------------------------------------------
    | Live Kerja (livestream kamera per site lewat LiveKit self-hosted)
    |--------------------------------------------------------------------
    | backend-api TIDAK pernah meneruskan video -- tugasnya cuma menerbitkan
    | token akses LiveKit berumur pendek yang mengunci user ke room site-nya
    | sendiri (lihat App\Services\LiveKitTokenIssuer). api_key/api_secret
    | wajib sama dengan bagian `keys:` di livekit-server/livekit.yaml.
    */
    'livekit' => [
        'url' => env('LIVEKIT_URL', 'wss://live.salahmu.fun'),
        'api_key' => env('LIVEKIT_API_KEY'),
        'api_secret' => env('LIVEKIT_API_SECRET'),
        'token_ttl_seconds' => (int) env('LIVEKIT_TOKEN_TTL_SECONDS', 600),
        // Sesi kerja tanpa heartbeat selama ini dianggap putus (tab ditutup,
        // HP mati, sinyal hilang) dan ditutup otomatis oleh
        // work-sessions:close-stale.
        'heartbeat_timeout_seconds' => (int) env('LIVE_HEARTBEAT_TIMEOUT_SECONDS', 120),
    ],

    /*
    |--------------------------------------------------------------------
    | Status server (menu Akses > Status server, super_admin)
    |--------------------------------------------------------------------
    | Alamat yang dipanggil backend untuk mengecek gateway & LiveKit
    | (sebaiknya alamat lokal di server, mis. http://127.0.0.1:3334), dan
    | unit systemd yang statusnya ditampilkan (`systemctl is-active`).
    | LiveKit kosong = diturunkan dari LIVEKIT_URL (ws -> http).
    */
    'status' => [
        'gateway_url' => env('LACAKSMB_STATUS_GATEWAY_URL', env('LACAKSMB_PUBLIC_GATEWAY_URL', 'https://ws.salahmu.fun')),
        'livekit_url' => env('LACAKSMB_STATUS_LIVEKIT_URL'),
        'systemd_units' => env('LACAKSMB_STATUS_SYSTEMD_UNITS', 'lacak-gateway,lacak-queue,lacak-scheduler,lacak-bot,php8.3-fpm'),
    ],
];
