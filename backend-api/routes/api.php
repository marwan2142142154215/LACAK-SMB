<?php

use App\Http\Controllers\Api\AuthController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API Routes — /api/v1/*
|--------------------------------------------------------------------------
| Dipakai bersama oleh web dashboard, APK master, dan jembatan bot Telegram.
| Semua wajib login lewat jalur yang sama di sini (standar 5.3: versi di URL).
*/

Route::prefix('v1')->group(function () {

    Route::prefix('auth')->group(function () {
        Route::post('/login', [AuthController::class, 'login']);
        Route::post('/2fa/setup/confirm', [AuthController::class, 'confirmTwoFactorSetup']);
        Route::post('/2fa/verify', [AuthController::class, 'verifyTwoFactor']);

        Route::middleware('auth:sanctum')->group(function () {
            Route::post('/logout', [AuthController::class, 'logout']);
            Route::get('/me', [AuthController::class, 'me']);
        });
    });

    Route::middleware('auth:sanctum')->group(function () {
        // Modul organizations/devices/commands/dsb. ditambah di tahap berikutnya.
    });
});
