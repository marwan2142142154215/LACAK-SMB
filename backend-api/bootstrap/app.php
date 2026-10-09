<?php

use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Spatie\Permission\Middleware\PermissionMiddleware;
use Spatie\Permission\Middleware\RoleMiddleware;
use App\Http\Middleware\ExtendTokenExpiry;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Bearer token murni untuk semua klien (dashboard, APK master, jembatan bot Telegram) —
        // tidak pakai cookie/stateful SPA karena klien bukan hanya browser.
        // Tidak ada route web "login" di aplikasi API-only ini, jadi guest yang
        // tidak terautentikasi tidak boleh di-redirect — biarkan AuthenticationException
        // naik dan dibalas sebagai JSON 401 oleh handler di bawah.
        $middleware->redirectGuestsTo(fn () => null);

        $middleware->alias([
            'role' => RoleMiddleware::class,
            'permission' => PermissionMiddleware::class,
            'extend-token' => ExtendTokenExpiry::class,
        ]);

        // Server ini diakses publik lewat Cloudflare Tunnel (TLS berhenti di
        // edge Cloudflare, origin ini sendiri dihubungi plain HTTP) — tanpa
        // percaya proxy, Laravel mengira semua request http:// dan
        // menghasilkan signed URL (download APK dsb) berskema salah
        // (http:// bukan https://). '*' aman di sini karena origin HANYA
        // dihubungi oleh cloudflared, bukan internet langsung.
        $middleware->trustProxies(at: '*');
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );

        // Aplikasi ini API-only: tidak ada route web "login" untuk jadi tujuan
        // redirect bawaan Authenticate middleware. Semua permintaan ke /api/*
        // yang tidak terautentikasi wajib dibalas JSON 401, bukan redirect.
        $exceptions->render(function (AuthenticationException $e, Request $request) {
            if ($request->is('api/*')) {
                return response()->json([
                    'success' => false,
                    'message' => 'Belum masuk atau token tidak berlaku',
                    'errors' => null,
                ], 401);
            }
        });
    })->create();
