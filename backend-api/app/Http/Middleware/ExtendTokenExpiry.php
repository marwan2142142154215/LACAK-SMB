<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Sesi idle-timeout (standar 6.4) ditegakkan sebagai SLIDING window, bukan
 * batas absolut: tiap request yang diautentikasi memperpanjang expires_at
 * token 2 jam lagi dari sekarang (lihat AuthController::TOKEN_IDLE_HOURS,
 * satu-satunya tempat angka itu didefinisikan). Staf yang aktif terus tidak
 * pernah kena logout paksa; yang diam 2 jam otomatis ditolak lewat
 * pengecekan expires_at bawaan Sanctum (Guard::isValidAccessToken) pada
 * request berikutnya.
 *
 * SENGAJA cuma memperpanjang token yang SUDAH punya expires_at -- token
 * akun layanan (telegram-bot, system-automation, lihat
 * App\Console\Commands\IssueTelegramBotToken) dibuat tanpa expires_at
 * (null) dan harus TETAP null selamanya, tidak boleh ikut dapat masa
 * berlaku dari middleware ini.
 */
class ExtendTokenExpiry
{
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        $token = $request->user()?->currentAccessToken();

        if ($token && $token->expires_at) {
            $token->forceFill([
                'expires_at' => now()->addHours(\App\Http\Controllers\Api\AuthController::TOKEN_IDLE_HOURS),
            ])->save();
        }

        return $response;
    }
}
