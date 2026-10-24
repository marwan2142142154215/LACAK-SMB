<?php

use App\Http\Controllers\Api\ApkBuildController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\ConsentDocumentController;
use App\Http\Controllers\Api\DashboardSummaryController;
use App\Http\Controllers\Api\DeviceCommandController;
use App\Http\Controllers\Api\DeviceController;
use App\Http\Controllers\Api\DeviceEnrollmentController;
use App\Http\Controllers\Api\DeviceOtpController;
use App\Http\Controllers\Api\GeofenceRuleController;
use App\Http\Controllers\Api\OrganizationController;
use App\Http\Controllers\Api\SecuritySettingController;
use App\Http\Controllers\Api\TelegramBindingController;
use App\Http\Controllers\Api\TelegramUserLinkController;
use App\Http\Controllers\Api\UserController;
use App\Http\Controllers\Api\ViolationLogController;
use App\Http\Controllers\Api\WorkSessionController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API Routes — /api/v1/*
|--------------------------------------------------------------------------
| Dipakai bersama oleh web dashboard, APK master, dan jembatan bot Telegram.
| Semua wajib login lewat jalur yang sama di sini (standar 5.3: versi di URL).
*/

Route::prefix('v1')->name('api.v1.')->group(function () {

    Route::prefix('auth')->group(function () {
        // throttle per-IP sebagai lapis pertama anti brute-force (lapis kedua:
        // hitung percobaan per challenge/device di controller). /login lebih
        // ketat karena tidak punya batas percobaan per challenge.
        Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:5,1');
        Route::post('/2fa/setup/confirm', [AuthController::class, 'confirmTwoFactorSetup'])
            ->middleware('throttle:10,1');
        Route::post('/2fa/verify', [AuthController::class, 'verifyTwoFactor'])
            ->middleware('throttle:10,1');

        Route::middleware(['auth:sanctum', 'extend-token'])->group(function () {
            Route::post('/logout', [AuthController::class, 'logout']);
            Route::get('/me', [AuthController::class, 'me']);
        });

        // Dipakai realtime-gateway untuk mengecek ulang sesi socket dashboard
        // secara berkala. Sengaja TANPA extend-token: pengecekan otomatis ini
        // bukan aktivitas staf, jadi tidak boleh memperpanjang idle timeout.
        Route::get('/session', [AuthController::class, 'session'])->middleware('auth:sanctum');
    });

    // Dipanggil langsung oleh APK pelacak di device target yang sedang
    // terkunci (tidak bisa login) — diamankan via device_uuid+OTP+rate limit,
    // bukan Sanctum. Lihat catatan di DeviceOtpController.
    Route::post('/device-otp/verify', [DeviceOtpController::class, 'verify'])
        ->middleware('throttle:10,1');

    // Dipanggil APK pelacak untuk mengambil rahasia device (sekali per
    // pendaftaran) — belum punya kredensial apa pun, jadi tanpa Sanctum;
    // dibatasi rate limit dan hanya berlaku untuk device pending_enrollment.
    Route::post('/device-enrollments/claim', [DeviceEnrollmentController::class, 'claim'])
        ->middleware('throttle:10,1');

    // Download via signed URL (standar 6.3) — tanpa auth:sanctum karena
    // tautannya sendiri sudah berumur pendek & terenkripsi tanda tangannya.
    Route::get('/consent-documents/{consentDocument}/download', [ConsentDocumentController::class, 'download'])
        ->name('consent-documents.download')
        ->middleware('signed');

    Route::get('/apk-builds/{apkBuild}/download', [ApkBuildController::class, 'download'])
        ->name('apk-builds.download')
        ->middleware('signed');

    Route::middleware(['auth:sanctum', 'extend-token'])->group(function () {
        Route::apiResource('organizations', OrganizationController::class);

        Route::get('/dashboard-summary', [DashboardSummaryController::class, 'show']);

        Route::apiResource('users', UserController::class);
        Route::post('/users/{user}/suspend', [UserController::class, 'suspend']);
        Route::post('/users/{user}/reactivate', [UserController::class, 'reactivate']);
        Route::post('/users/{user}/reset-2fa', [UserController::class, 'reset2fa']);
        Route::put('/users/{user}/site-access', [UserController::class, 'syncSiteAccess']);

        Route::apiResource('consent-documents', ConsentDocumentController::class)->only(['index', 'store', 'show']);
        Route::post('/consent-documents/{consentDocument}/revoke', [ConsentDocumentController::class, 'revoke']);

        Route::apiResource('devices', DeviceController::class);
        Route::get('/devices/{device}/commands', [DeviceCommandController::class, 'index']);
        Route::post('/devices/{device}/commands', [DeviceCommandController::class, 'store']);
        Route::post('/devices/{device}/otp', [DeviceOtpController::class, 'generate']);
        Route::post('/devices/{device}/re-enroll', [DeviceEnrollmentController::class, 'reEnroll']);
        Route::get('/devices/{device}/violations', [ViolationLogController::class, 'index']);

        Route::apiResource('geofence-rules', GeofenceRuleController::class)->except(['show']);

        Route::apiResource('apk-builds', ApkBuildController::class)->only(['index', 'store', 'show', 'destroy']);
        Route::post('/apk-builds/generate', [ApkBuildController::class, 'generate'])->name('apk-builds.generate');

        Route::apiResource('telegram-bindings', TelegramBindingController::class)->only(['index', 'store', 'destroy']);
        Route::get('/telegram-bindings-lookup', [TelegramBindingController::class, 'lookup']);

        // Live Kerja (livestream kamera per site lewat LiveKit) -- lihat
        // WorkSessionController untuk aturan isolasi antar-site.
        Route::get('/live/sites', [WorkSessionController::class, 'sites']);
        Route::get('/live/sessions', [WorkSessionController::class, 'index']);
        Route::get('/live/overview', [WorkSessionController::class, 'overview']);
        Route::post('/live/sessions/start', [WorkSessionController::class, 'start'])->middleware('throttle:10,1');
        Route::post('/live/sessions/heartbeat', [WorkSessionController::class, 'heartbeat'])->middleware('throttle:60,1');
        Route::post('/live/sessions/end', [WorkSessionController::class, 'end']);
        Route::get('/live/app', [WorkSessionController::class, 'app']);
        Route::get('/live/activity', [WorkSessionController::class, 'activity']);
        Route::post('/live/watch-token', [WorkSessionController::class, 'watchToken'])->middleware('throttle:30,1');
        Route::apiResource('telegram-user-links', TelegramUserLinkController::class)->only(['index', 'store', 'destroy']);
        Route::get('/telegram-user-links-lookup', [TelegramUserLinkController::class, 'lookup']);

        // Pengaturan keamanan sistem (wajib/tidaknya 2FA) -- super_admin saja.
        Route::get('/settings/security', [SecuritySettingController::class, 'show']);
        Route::put('/settings/security', [SecuritySettingController::class, 'update']);
    });
});
