<?php

use App\Models\User;
use Database\Seeders\RolesAndPermissionsSeeder;
use Illuminate\Support\Facades\Crypt;
use Laravel\Sanctum\PersonalAccessToken;
use PragmaRX\Google2FA\Google2FA;

beforeEach(function () {
    $this->seed(RolesAndPermissionsSeeder::class);
});

test('login salah password ditolak 401', function () {
    $user = User::factory()->create(['password' => bcrypt('password-benar')]);

    $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'password-salah',
    ])->assertStatus(401)
        ->assertJson(['success' => false]);
});

test('login pertama kali (belum confirm 2FA) balas QR setup, bukan token', function () {
    $user = User::factory()->create([
        'password' => bcrypt('password-benar'),
        'two_factor_confirmed_at' => null,
        'two_factor_secret' => null,
    ]);

    $response = $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'password-benar',
    ])->assertOk();

    $response->assertJsonPath('data.requires_2fa_setup', true);
    expect($response->json('data.setup_token'))->not->toBeEmpty();
    expect($response->json('data.access_token'))->toBeNull();
});

test('konfirmasi setup 2FA dengan kode benar mengeluarkan token idle 2 jam', function () {
    $user = User::factory()->create([
        'password' => bcrypt('password-benar'),
        'two_factor_confirmed_at' => null,
        'two_factor_secret' => null,
    ]);

    $login = $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'password-benar',
    ])->assertOk();

    $setupToken = $login->json('data.setup_token');
    $secret = $login->json('data.secret_manual_entry');

    $google2fa = new Google2FA;
    $code = $google2fa->getCurrentOtp($secret);

    $confirm = $this->postJson('/api/v1/auth/2fa/setup/confirm', [
        'setup_token' => $setupToken,
        'code' => $code,
    ])->assertOk();

    $accessToken = $confirm->json('data.access_token');
    expect($accessToken)->not->toBeEmpty();

    $tokenId = explode('|', $accessToken)[0];
    $token = PersonalAccessToken::find($tokenId);

    expect($token->expires_at)->not->toBeNull();
    $minutesAhead = now()->diffInMinutes($token->expires_at, false);
    expect($minutesAhead)->toBeLessThan(130)->toBeGreaterThan(110);
});

test('kode 2FA salah saat setup ditolak 422', function () {
    $user = User::factory()->create([
        'password' => bcrypt('password-benar'),
        'two_factor_confirmed_at' => null,
        'two_factor_secret' => null,
    ]);

    $login = $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'password-benar',
    ])->assertOk();

    $this->postJson('/api/v1/auth/2fa/setup/confirm', [
        'setup_token' => $login->json('data.setup_token'),
        'code' => '000000',
    ])->assertStatus(422);
});

test('login dengan 2FA sudah confirmed minta challenge, bukan langsung token', function () {
    $secret = (new Google2FA)->generateSecretKey();

    $user = User::factory()->create([
        'password' => bcrypt('password-benar'),
        'two_factor_confirmed_at' => now(),
        'two_factor_secret' => Crypt::encryptString($secret),
    ]);

    $response = $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'password-benar',
    ])->assertOk();

    $response->assertJsonPath('data.requires_2fa', true);
    expect($response->json('data.challenge_token'))->not->toBeEmpty();
});

test('verifikasi 2FA dengan kode benar mengeluarkan token', function () {
    $secret = (new Google2FA)->generateSecretKey();

    $user = User::factory()->create([
        'password' => bcrypt('password-benar'),
        'two_factor_confirmed_at' => now(),
        'two_factor_secret' => Crypt::encryptString($secret),
    ]);

    $login = $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'password-benar',
    ])->assertOk();

    $code = (new Google2FA)->getCurrentOtp($secret);

    $this->postJson('/api/v1/auth/2fa/verify', [
        'challenge_token' => $login->json('data.challenge_token'),
        'code' => $code,
    ])->assertOk()
        ->assertJsonPath('data.user.username', $user->username);
});

test('token yang sudah lewat masa idle ditolak 401', function () {
    $user = User::factory()->create();
    $token = $user->createToken('web_dashboard-test', ['*'], now()->subMinute());

    $this->withHeader('Authorization', 'Bearer '.$token->plainTextToken)
        ->getJson('/api/v1/auth/me')
        ->assertStatus(401);
});

test('request terautentikasi menggeser maju expires_at token (sliding idle timeout)', function () {
    $user = User::factory()->create();
    $token = $user->createToken('web_dashboard-test', ['*'], now()->addMinutes(5));
    $tokenId = $token->accessToken->id;

    $this->withHeader('Authorization', 'Bearer '.$token->plainTextToken)
        ->getJson('/api/v1/auth/me')
        ->assertOk();

    $fresh = PersonalAccessToken::find($tokenId);
    expect(now()->diffInMinutes($fresh->expires_at, false))->toBeGreaterThan(100);
});

/**
 * Regresi dari audit keamanan menyeluruh: /auth/login tidak punya rate
 * limit sama sekali sebelumnya -- password bisa ditebak tanpa batas.
 */
test('login dibatasi rate limit setelah beberapa kali percobaan', function () {
    $user = User::factory()->create(['password' => bcrypt('password-benar')]);

    for ($i = 0; $i < 5; $i++) {
        $this->postJson('/api/v1/auth/login', [
            'username' => $user->username,
            'password' => 'salah',
        ])->assertStatus(401);
    }

    $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'salah',
    ])->assertStatus(429);
});

test('token tanpa expires_at (akun layanan) tidak disentuh ExtendTokenExpiry', function () {
    $user = User::factory()->create();
    $token = $user->createToken('telegram-bot-service');
    $tokenId = $token->accessToken->id;

    $this->withHeader('Authorization', 'Bearer '.$token->plainTextToken)
        ->getJson('/api/v1/auth/me')
        ->assertOk();

    $fresh = PersonalAccessToken::find($tokenId);
    expect($fresh->expires_at)->toBeNull();
});
