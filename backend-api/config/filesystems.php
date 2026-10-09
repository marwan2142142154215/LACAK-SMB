<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Default Filesystem Disk
    |--------------------------------------------------------------------------
    |
    | Here you may specify the default filesystem disk that should be used
    | by the framework. The "local" disk, as well as a variety of cloud
    | based disks are available to your application for file storage.
    |
    */

    'default' => env('FILESYSTEM_DISK', 'local'),

    // Disk tujuan berkas penting (dokumen consent, APK build) — wajib DigitalOcean
    // Spaces (standar 6.3). DOCUMENTS_DISK hanya dihormati saat APP_ENV=local,
    // supaya dev bisa memakai disk 'local' sebelum kredensial Spaces tersedia
    // tanpa risiko production ikut menyimpan berkas di disk server.
    'documents_disk' => env('APP_ENV', 'production') === 'local'
        ? env('DOCUMENTS_DISK', 'spaces')
        : 'spaces',

    /*
    |--------------------------------------------------------------------------
    | Filesystem Disks
    |--------------------------------------------------------------------------
    |
    | Below you may configure as many filesystem disks as necessary, and you
    | may even configure multiple disks for the same driver. Examples for
    | most supported storage drivers are configured here for reference.
    |
    | Supported drivers: "local", "ftp", "sftp", "s3"
    |
    */

    'disks' => [

        'local' => [
            'driver' => 'local',
            'root' => storage_path('app/private'),
            'serve' => true,
            'throw' => false,
            'report' => false,
        ],

        'public' => [
            'driver' => 'local',
            'root' => storage_path('app/public'),
            'url' => rtrim(env('APP_URL', 'http://localhost'), '/').'/storage',
            'visibility' => 'public',
            'throw' => false,
            'report' => false,
        ],

        's3' => [
            'driver' => 's3',
            'key' => env('AWS_ACCESS_KEY_ID'),
            'secret' => env('AWS_SECRET_ACCESS_KEY'),
            'region' => env('AWS_DEFAULT_REGION'),
            'bucket' => env('AWS_BUCKET'),
            'url' => env('AWS_URL'),
            'endpoint' => env('AWS_ENDPOINT'),
            'use_path_style_endpoint' => env('AWS_USE_PATH_STYLE_ENDPOINT', false),
            'throw' => false,
            'report' => false,
        ],

        // Standar 6.3: berkas penting (consent, APK build) wajib di DigitalOcean
        // Spaces, bukan disk lokal server. Spaces kompatibel S3, jadi pakai driver s3.
        // Berkas privat dan hanya dibuka lewat tautan bertanda waktu; 'throw' aktif
        // supaya kegagalan unggah tidak diam-diam menyimpan path kosong ke DB.
        'spaces' => [
            'driver' => 's3',
            'key' => env('DO_SPACES_KEY'),
            'secret' => env('DO_SPACES_SECRET'),
            'region' => env('DO_SPACES_REGION') ?: 'sgp1',
            'bucket' => env('DO_SPACES_BUCKET'),
            'endpoint' => env('DO_SPACES_ENDPOINT'),
            'url' => env('DO_SPACES_URL'),
            'use_path_style_endpoint' => false,
            'visibility' => 'private',
            'throw' => true,
            'report' => false,
        ],

    ],

    /*
    |--------------------------------------------------------------------------
    | Symbolic Links
    |--------------------------------------------------------------------------
    |
    | Here you may configure the symbolic links that will be created when the
    | `storage:link` Artisan command is executed. The array keys should be
    | the locations of the links and the values should be their targets.
    |
    */

    'links' => [
        public_path('storage') => storage_path('app/public'),
    ],

];
