<?php

namespace Tests\Feature;

use App\Models\Device;
use App\Models\Organization;
use App\Models\User;
use App\Support\TwoFactorPolicy;
use Database\Seeders\RolesAndPermissionsSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Spatie\Activitylog\Models\Activity;
use Tests\TestCase;

class ActivityLogTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed(RolesAndPermissionsSeeder::class);
        config([
            'lacaksmb.livekit.url' => 'wss://live.test',
            'lacaksmb.livekit.api_key' => 'test-key',
            'lacaksmb.livekit.api_secret' => str_repeat('s', 32),
        ]);
    }

    private function userWithRole(string $role, ?Organization $org = null): User
    {
        $user = User::factory()->create(['organization_id' => $org?->id, 'password' => bcrypt('password-benar')]);
        $user->assignRole($role);

        return $user;
    }

    /** @return array<int, array<string, mixed>> */
    private function entries(User $viewer, array $query = []): array
    {
        return $this->actingAs($viewer, 'sanctum')
            ->getJson('/api/v1/activity-logs?'.http_build_query($query))
            ->assertOk()
            ->json('data.entries');
    }

    public function test_actions_are_logged_with_actor_site_ip_device_and_changes(): void
    {
        $org = Organization::factory()->create(['name' => 'Gudang Utama']);
        $siteAdmin = $this->userWithRole('site_admin', $org);
        $device = Device::factory()->create(['organization_id' => $org->id, 'device_name' => 'HP Kasir']);

        $this->actingAs($siteAdmin, 'sanctum')
            ->withHeaders(['User-Agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'])
            ->putJson("/api/v1/devices/{$device->id}", ['device_name' => 'HP Kasir Depan'])
            ->assertOk();

        $entry = collect($this->entries($this->userWithRole('super_admin')))->firstWhere('category', 'device');

        $this->assertSame('Mengubah device HP Kasir', $entry['description']);
        $this->assertSame('ok', $entry['result']);
        $this->assertSame($siteAdmin->id, $entry['causer']['id']);
        $this->assertSame('Gudang Utama', $entry['organization']['name']);
        $this->assertSame('Chrome · Windows', $entry['device']);
        $this->assertNotEmpty($entry['ip_address']);
        $this->assertSame([['field' => 'device_name', 'old' => 'HP Kasir', 'new' => 'HP Kasir Depan']], $entry['changes'][0]['fields']);
    }

    public function test_login_success_and_failure_are_logged_without_passwords(): void
    {
        TwoFactorPolicy::setRequired(false);
        $staff = $this->userWithRole('staff_viewer', Organization::factory()->create());

        $this->postJson('/api/v1/auth/login', ['username' => $staff->username, 'password' => 'salah'])->assertStatus(401);
        $this->postJson('/api/v1/auth/login', ['username' => $staff->username, 'password' => 'password-benar'])->assertOk();

        $entries = collect($this->entries($this->userWithRole('super_admin'), ['category' => 'auth']));
        $descriptions = $entries->pluck('description', 'result');

        // Login gagal: yang mencoba belum tentu pemilik akun -> akun dicatat sebagai sasaran.
        $failed = $entries->firstWhere('result', 'denied');
        $this->assertNull($failed['causer']);
        $this->assertSame($staff->username, $failed['subject']['name']);
        $this->assertSame($staff->id, $entries->firstWhere('result', 'ok')['causer']['id']);

        $this->assertSame('Login berhasil', $descriptions['ok']);
        $this->assertStringStartsWith('Login gagal', $descriptions['denied']);
        $this->assertStringNotContainsString('password-benar', Activity::all()->toJson());
        $this->assertStringNotContainsString('"salah"', Activity::all()->toJson());
    }

    public function test_denied_actions_are_logged_too(): void
    {
        $org = Organization::factory()->create();
        $staff = $this->userWithRole('staff_viewer', $org);
        $device = Device::factory()->create(['organization_id' => $org->id]);

        // Staf tidak punya izin mengunci device.
        $this->actingAs($staff, 'sanctum')
            ->postJson("/api/v1/devices/{$device->id}/commands", ['command_type' => 'lock', 'issued_via' => 'web_dashboard'])
            ->assertForbidden();

        $entry = $this->entries($this->userWithRole('super_admin'), ['result' => 'denied'])[0];
        $this->assertSame('perintah', $entry['category']);
        $this->assertSame(403, $entry['status']);
        $this->assertSame($staff->id, $entry['causer']['id']);
    }

    public function test_site_admin_only_sees_their_own_site_and_staff_cannot_open_the_log(): void
    {
        $orgA = Organization::factory()->create();
        $orgB = Organization::factory()->create();
        $adminA = $this->userWithRole('site_admin', $orgA);
        $adminB = $this->userWithRole('site_admin', $orgB);

        $this->actingAs($adminA, 'sanctum')->postJson('/api/v1/geofence-rules', ['organization_id' => $orgA->id, 'rule_name' => 'Kantor A', 'allowed_ssid' => 'WIFI-A']);
        $this->actingAs($adminB, 'sanctum')->postJson('/api/v1/geofence-rules', ['organization_id' => $orgB->id, 'rule_name' => 'Kantor B', 'allowed_ssid' => 'WIFI-B']);

        $seenByA = collect($this->entries($adminA))->pluck('description');
        $this->assertTrue($seenByA->contains('Membuat aturan geofence Kantor A'));
        $this->assertFalse($seenByA->contains('Membuat aturan geofence Kantor B'));

        $this->actingAs($adminA, 'sanctum')->getJson("/api/v1/activity-logs?organization_id={$orgB->id}")->assertForbidden();
        $this->actingAs($this->userWithRole('staff_viewer', $orgA), 'sanctum')->getJson('/api/v1/activity-logs')->assertForbidden();
    }

    public function test_work_sessions_and_read_requests_are_not_in_the_activity_log(): void
    {
        $org = Organization::factory()->create();
        $staff = $this->userWithRole('staff_viewer', $org);
        $viewer = $this->userWithRole('super_admin');
        // Data awal tes (pembuatan akun di atas) bukan bagian yang diuji.
        Activity::query()->delete();

        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/start')->assertCreated();
        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/heartbeat', ['camera_active' => true])->assertOk();
        $this->actingAs($staff, 'sanctum')->getJson('/api/v1/devices')->assertOk();

        $this->assertSame([], $this->entries($viewer));
    }
}
