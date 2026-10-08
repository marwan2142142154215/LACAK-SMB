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

    'public_gateway_url' => env('LACAKSMB_PUBLIC_GATEWAY_URL', 'https://gw.lacaksmbbot.com'),
    'public_backend_api_url' => env('LACAKSMB_PUBLIC_BACKEND_API_URL', 'https://api.lacaksmbbot.com/api/v1'),

    // Nama distro WSL yang dipakai untuk build Gradle (lihat catatan proyek:
    // Gradle tidak bisa jalan langsung di Windows native di mesin ini).
    'wsl_distro' => env('LACAKSMB_WSL_DISTRO', 'Ubuntu'),

    // Tipe 'server' tidak perlu Gradle -- ApkBuilder cukup menyalin
    // lacak-server.exe yang sudah ter-build (server-gui).
    'server_exe_path' => env('LACAKSMB_SERVER_EXE_PATH', base_path('../lacak-server.exe')),
];
