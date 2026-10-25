<?php

use App\Models\Organization;
use App\Models\User;
use App\Models\WorkSession;
use App\Support\TwoFactorPolicy;
use Database\Seeders\RolesAndPermissionsSeeder;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
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

test('username tidak peka huruf besar saat login dan selalu disimpan huruf kecil', function () {
    $user = User::factory()->create(['username' => 'Staf.A1', 'password' => bcrypt('password-benar')]);

    expect($user->fresh()->username)->toBe('staf.a1');

    // Keyboard HP mengapitalkan huruf pertama -- tetap harus bisa masuk.
    foreach (['Staf.a1', 'STAF.A1', ' staf.a1 '] as $typed) {
        $this->postJson('/api/v1/auth/login', ['username' => $typed, 'password' => 'password-benar'])
            ->assertOk()
            ->assertJsonPath('success', true);
    }
});

test('membuat staf dengan username huruf besar disimpan huruf kecil dan tidak bisa menduplikasi', function () {
    $root = User::factory()->create();
    $root->assignRole('super_admin');
    User::factory()->create(['username' => 'budi']);

    $payload = ['name' => 'Budi Dua', 'email' => 'budi2@example.com', 'password' => 'rahasia-panjang', 'role' => 'admin'];

    $this->actingAs($root, 'sanctum')
        ->postJson('/api/v1/users', [...$payload, 'username' => 'Budi'])
        ->assertUnprocessable()
        ->assertJsonValidationErrors('username');

    $this->actingAs($root, 'sanctum')
        ->postJson('/api/v1/users', [...$payload, 'username' => 'Budi.Dua'])
        ->assertCreated();

    expect(User::where('username', 'budi.dua')->exists())->toBeTrue();
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
 * /auth/session dipakai realtime-gateway untuk cek ulang sesi socket tiap
 * 5 menit -- kalau ikut menggeser expires_at, tab dashboard yang didiamkan
 * tidak akan pernah kena idle timeout.
 */
test('cek ulang sesi lewat /auth/session tidak menggeser expires_at token', function () {
    $user = User::factory()->create();
    $token = $user->createToken('web_dashboard-test', ['*'], now()->addMinutes(5));
    $tokenId = $token->accessToken->id;

    $this->withHeader('Authorization', 'Bearer '.$token->plainTextToken)
        ->getJson('/api/v1/auth/session')
        ->assertOk();

    $fresh = PersonalAccessToken::find($tokenId);
    expect(now()->diffInMinutes($fresh->expires_at, false))->toBeLessThan(6);
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

/** Login password tanpa 2FA, kembalikan token Bearer-nya. */
function loginToken(User $user, string $client = 'web_dashboard'): string
{
    return test()->postJson('/api/v1/auth/login', ['username' => $user->username, 'password' => 'password-benar', 'client' => $client])
        ->assertOk()
        ->json('data.access_token');
}

test('satu akun satu sesi: login baru mengakhiri sesi di perangkat lain', function () {
    TwoFactorPolicy::setRequired(false);
    $user = User::factory()->create(['password' => bcrypt('password-benar')]);

    $oldToken = loginToken($user, 'web_dashboard');
    $newToken = loginToken($user, 'master_app');
    app('auth')->forgetGuards();

    $this->withHeader('Authorization', 'Bearer '.$oldToken)
        ->getJson('/api/v1/auth/me')
        ->assertStatus(401)
        ->assertJsonPath('errors.reason', 'session_replaced');

    app('auth')->forgetGuards();
    $this->withHeader('Authorization', 'Bearer '.$newToken)->getJson('/api/v1/auth/me')->assertOk();

    expect($user->tokens()->count())->toBe(1);
});

test('token tidak berlaku biasa tetap dibalas 401 tanpa alasan login di perangkat lain', function () {
    $this->withHeader('Authorization', 'Bearer 999|token-asal')
        ->getJson('/api/v1/auth/me')
        ->assertStatus(401)
        ->assertJsonPath('errors', null);
});

test('login tidak mencabut token akun layanan tanpa expires_at', function () {
    TwoFactorPolicy::setRequired(false);
    $user = User::factory()->create(['password' => bcrypt('password-benar')]);
    $serviceToken = $user->createToken('telegram-bot-service')->plainTextToken;

    loginToken($user);
    app('auth')->forgetGuards();

    $this->withHeader('Authorization', 'Bearer '.$serviceToken)->getJson('/api/v1/auth/me')->assertOk();
});

test('login baru memutus siaran Live Kerja perangkat lama tanpa menutup sesi kerjanya', function () {
    TwoFactorPolicy::setRequired(false);
    config([
        'lacaksmb.livekit.url' => 'wss://live.test',
        'lacaksmb.livekit.api_key' => 'test-key',
        'lacaksmb.livekit.api_secret' => str_repeat('s', 32),
    ]);
    Http::fake(['live.test/*' => Http::response([], 200)]);

    $staff = User::factory()->create(['password' => bcrypt('password-benar'), 'organization_id' => Organization::factory()->create()->id]);
    $staff->assignRole('staff_viewer');

    $this->withHeader('Authorization', 'Bearer '.loginToken($staff))
        ->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])
        ->assertCreated();

    loginToken($staff);

    Http::assertSent(fn ($request) => str_ends_with($request->url(), '/twirp/livekit.RoomService/RemoveParticipant')
        && $request['identity'] === "user-{$staff->id}");
    expect(WorkSession::open()->where('user_id', $staff->id)->exists())->toBeTrue();
});

test('login mencatat perangkat: browser HP dan APK = phone, browser komputer = computer', function () {
    TwoFactorPolicy::setRequired(false);
    $user = User::factory()->create(['password' => bcrypt('password-benar')]);
    $deviceOfLatestLogin = fn () => $user->tokens()->latest('id')->value('device_type');

    $this->withHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')->postJson('/api/v1/auth/login', ['username' => $user->username, 'password' => 'password-benar'])->assertOk();
    expect($deviceOfLatestLogin())->toBe('computer');

    $this->withHeader('User-Agent', 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36')->postJson('/api/v1/auth/login', ['username' => $user->username, 'password' => 'password-benar'])->assertOk();
    expect($deviceOfLatestLogin())->toBe('phone');

    $this->withHeader('User-Agent', 'okhttp/4.12.0')->postJson('/api/v1/auth/login', ['username' => $user->username, 'password' => 'password-benar', 'client' => 'master_app'])->assertOk();
    expect($deviceOfLatestLogin())->toBe('phone');
});

test('logout benar-benar mencabut token -- tidak dihidupkan lagi oleh ExtendTokenExpiry', function () {
    TwoFactorPolicy::setRequired(false);
    $user = User::factory()->create(['password' => bcrypt('password-benar')]);
    $token = loginToken($user);
    app('auth')->forgetGuards();

    $this->withHeader('Authorization', 'Bearer '.$token)->postJson('/api/v1/auth/logout')->assertOk();

    expect($user->tokens()->count())->toBe(0);

    app('auth')->forgetGuards();
    $this->withHeader('Authorization', 'Bearer '.$token)->getJson('/api/v1/auth/me')->assertStatus(401);
});
