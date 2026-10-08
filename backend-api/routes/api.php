<?php

use App\Http\Controllers\Api\ApkBuildController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\ConsentDocumentController;
use App\Http\Controllers\Api\DeviceCommandController;
use App\Http\Controllers\Api\DeviceController;
use App\Http\Controllers\Api\DeviceOtpController;
use App\Http\Controllers\Api\GeofenceRuleController;
use App\Http\Controllers\Api\OrganizationController;
use App\Http\Controllers\Api\TelegramBindingController;
use App\Http\Controllers\Api\ViolationLogController;
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
        Route::post('/login', [AuthController::class, 'login']);
        Route::post('/2fa/setup/confirm', [AuthController::class, 'confirmTwoFactorSetup']);
        Route::post('/2fa/verify', [AuthController::class, 'verifyTwoFactor']);

        Route::middleware('auth:sanctum')->group(function () {
            Route::post('/logout', [AuthController::class, 'logout']);
            Route::get('/me', [AuthController::class, 'me']);
        });
    });

    // Dipanggil langsung oleh APK pelacak di device target yang sedang
    // terkunci (tidak bisa login) — diamankan via device_uuid+OTP+rate limit,
    // bukan Sanctum. Lihat catatan di DeviceOtpController.
    Route::post('/device-otp/verify', [DeviceOtpController::class, 'verify'])
        ->middleware('throttle:10,1');

    // Download via signed URL (standar 6.3) — tanpa auth:sanctum karena
    // tautannya sendiri sudah berumur pendek & terenkripsi tanda tangannya.
    Route::get('/consent-documents/{consentDocument}/download', [ConsentDocumentController::class, 'download'])
        ->name('consent-documents.download')
        ->middleware('signed');

    Route::get('/apk-builds/{apkBuild}/download', [ApkBuildController::class, 'download'])
        ->name('apk-builds.download')
        ->middleware('signed');

    Route::middleware('auth:sanctum')->group(function () {
        Route::apiResource('organizations', OrganizationController::class);

        Route::apiResource('consent-documents', ConsentDocumentController::class)->only(['index', 'store', 'show']);
        Route::post('/consent-documents/{consentDocument}/revoke', [ConsentDocumentController::class, 'revoke']);

        Route::apiResource('devices', DeviceController::class);
        Route::get('/devices/{device}/commands', [DeviceCommandController::class, 'index']);
        Route::post('/devices/{device}/commands', [DeviceCommandController::class, 'store']);
        Route::post('/devices/{device}/otp', [DeviceOtpController::class, 'generate']);
        Route::get('/devices/{device}/violations', [ViolationLogController::class, 'index']);

        Route::apiResource('geofence-rules', GeofenceRuleController::class)->except(['show']);

        Route::apiResource('apk-builds', ApkBuildController::class)->only(['index', 'store']);
        Route::post('/apk-builds/generate', [ApkBuildController::class, 'generate'])->name('apk-builds.generate');

        Route::apiResource('telegram-bindings', TelegramBindingController::class)->only(['index', 'store', 'destroy']);
        Route::get('/telegram-bindings-lookup', [TelegramBindingController::class, 'lookup']);
    });
});
