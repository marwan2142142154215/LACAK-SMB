<?php

use App\Models\User;
use App\Support\TwoFactorPolicy;
use Database\Seeders\DemoAccountsSeeder;
use Database\Seeders\RolesAndPermissionsSeeder;

beforeEach(function () {
    $this->seed(RolesAndPermissionsSeeder::class);
});

function userWithRole(string $role): User
{
    $user = User::factory()->create(['password' => bcrypt('password-benar')]);
    $user->assignRole($role);

    return $user;
}

test('bawaannya 2FA wajib: login tidak langsung memberi token', function () {
    $user = userWithRole('staff_viewer');

    $this->postJson('/api/v1/auth/login', ['username' => $user->username, 'password' => 'password-benar'])
        ->assertOk()
        ->assertJsonPath('data.requires_2fa', true)
        ->assertJsonMissingPath('data.access_token');
});

test('saat 2FA dimatikan, login dengan password langsung memberi token', function () {
    TwoFactorPolicy::setRequired(false);
    $user = userWithRole('staff_viewer');

    $this->postJson('/api/v1/auth/login', ['username' => $user->username, 'password' => 'password-benar'])
        ->assertOk()
        ->assertJsonPath('data.user.username', $user->username)
        ->assertJsonStructure(['data' => ['access_token']]);

    // Password salah tetap ditolak walau 2FA mati.
    $this->postJson('/api/v1/auth/login', ['username' => $user->username, 'password' => 'salah'])
        ->assertStatus(401);
});

test('hanya super_admin yang boleh melihat dan mengubah pengaturan 2FA', function () {
    foreach (['admin', 'leader', 'site_admin', 'staff_viewer'] as $role) {
        $user = userWithRole($role);

        $this->actingAs($user, 'sanctum')->getJson('/api/v1/settings/security')->assertForbidden();
        $this->actingAs($user, 'sanctum')->putJson('/api/v1/settings/security', ['two_factor_required' => false])->assertForbidden();
    }

    expect(TwoFactorPolicy::isRequired())->toBeTrue();
});

test('super_admin bisa mematikan dan menyalakan 2FA, dan perubahannya tercatat', function () {
    $root = userWithRole('super_admin');

    $this->actingAs($root, 'sanctum')->getJson('/api/v1/settings/security')
        ->assertOk()
        ->assertJsonPath('data.two_factor_required', true);

    $this->actingAs($root, 'sanctum')->putJson('/api/v1/settings/security', ['two_factor_required' => false])
        ->assertOk()
        ->assertJsonPath('data.two_factor_required', false);
    expect(TwoFactorPolicy::isRequired())->toBeFalse();

    $this->assertDatabaseHas('app_settings', ['key' => TwoFactorPolicy::SETTING_KEY, 'updated_by' => $root->id]);

    $this->actingAs($root, 'sanctum')->putJson('/api/v1/settings/security', ['two_factor_required' => true])->assertOk();
    expect(TwoFactorPolicy::isRequired())->toBeTrue();
});

test('perintah security:two-factor mengubah kewajiban 2FA', function () {
    $this->artisan('security:two-factor off')->assertSuccessful();
    expect(TwoFactorPolicy::isRequired())->toBeFalse();

    $this->artisan('security:two-factor on')->assertSuccessful();
    expect(TwoFactorPolicy::isRequired())->toBeTrue();

    $this->artisan('security:two-factor nanti')->assertFailed();
});

test('seeder akun dummy membuat akun per peran dan aman dijalankan ulang', function () {
    $this->seed(DemoAccountsSeeder::class);
    $this->seed(DemoAccountsSeeder::class);

    expect(User::where('username', 'root')->first()->hasRole('super_admin'))->toBeTrue()
        ->and(User::where('username', 'staf.a1')->first()->organization->name)->toBe('Site Uji A')
        ->and(User::where('username', 'leader.uji')->first()->siteAccess()->count())->toBe(2)
        ->and(User::where('username', 'like', '%.%')->orWhere('username', 'root')->count())->toBe(7);
});
