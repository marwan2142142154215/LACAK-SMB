<?php

namespace Tests\Feature;

use App\Models\ApkBuild;
use App\Models\Organization;
use App\Models\User;
use App\Models\WorkSession;
use Database\Seeders\RolesAndPermissionsSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class WorkSessionLiveTest extends TestCase
{
    use RefreshDatabase;

    private const SECRET = 'test-secret-yang-cukup-panjang-untuk-hs256';

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed(RolesAndPermissionsSeeder::class);

        config([
            'lacaksmb.livekit.url' => 'wss://live.test',
            'lacaksmb.livekit.api_key' => 'test-key',
            'lacaksmb.livekit.api_secret' => self::SECRET,
        ]);

        Http::fake(['live.test/*' => Http::response([], 200)]);
    }

    private function staffInOrganization(Organization $org, string $role = 'staff_viewer'): User
    {
        $user = User::factory()->create(['organization_id' => $org->id]);
        $user->assignRole($role);

        return $user;
    }

    private function leaderWithAccessTo(Organization $org): User
    {
        $leader = User::factory()->create(['organization_id' => null]);
        $leader->assignRole('leader');
        $leader->siteAccess()->attach($org->id);

        return $leader;
    }

    /**
     * Decode & verifikasi tanda tangan token LiveKit, kembalikan klaimnya.
     *
     * @return array<string, mixed>
     */
    private function decodeLiveKitToken(string $token): array
    {
        [$header, $payload, $signature] = explode('.', $token);
        $expected = rtrim(strtr(base64_encode(hash_hmac('sha256', "{$header}.{$payload}", self::SECRET, true)), '+/', '-_'), '=');

        $this->assertSame($expected, $signature);

        return json_decode(base64_decode(strtr($payload, '-_', '+/')), true);
    }

    public function test_broadcaster_token_is_scoped_to_own_site_room(): void
    {
        $org = Organization::factory()->create();
        $staff = $this->staffInOrganization($org);

        $response = $this->actingAs($staff, 'sanctum')
            ->postJson('/api/v1/live/sessions/start')
            ->assertCreated()
            ->assertJsonPath('data.room', "site-{$org->id}");

        $claims = $this->decodeLiveKitToken($response->json('data.token'));

        $this->assertSame("user-{$staff->id}", $claims['sub']);
        $this->assertSame("site-{$org->id}", $claims['video']['room']);
        $this->assertTrue($claims['video']['canPublish']);
        $this->assertSame(['camera', 'microphone', 'screen_share'], $claims['video']['canPublishSources']);
        $this->assertSame(1, WorkSession::open()->where('user_id', $staff->id)->count());
    }

    public function test_starting_twice_does_not_create_duplicate_sessions(): void
    {
        $staff = $this->staffInOrganization(Organization::factory()->create());

        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/start')->assertCreated();
        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/start')->assertCreated();

        $this->assertSame(1, WorkSession::where('user_id', $staff->id)->count());
    }

    public function test_staff_cannot_watch_or_list_another_site(): void
    {
        $orgB = Organization::factory()->create();
        $staffA = $this->staffInOrganization(Organization::factory()->create());

        $this->actingAs($staffA, 'sanctum')
            ->postJson('/api/v1/live/watch-token', ['organization_id' => $orgB->id])
            ->assertForbidden();

        $this->actingAs($staffA, 'sanctum')
            ->getJson("/api/v1/live/sessions?organization_id={$orgB->id}")
            ->assertForbidden();
    }

    public function test_live_list_only_contains_same_site_staff(): void
    {
        $orgA = Organization::factory()->create();
        $staffA = $this->staffInOrganization($orgA);
        $colleagueA = $this->staffInOrganization($orgA);
        $staffB = $this->staffInOrganization(Organization::factory()->create());

        foreach ([$colleagueA, $staffB] as $user) {
            $this->actingAs($user, 'sanctum')->postJson('/api/v1/live/sessions/start')->assertCreated();
        }

        $this->actingAs($staffA, 'sanctum')
            ->getJson('/api/v1/live/sessions')
            ->assertOk()
            ->assertJsonCount(1, 'data.items')
            ->assertJsonPath('data.items.0.user_id', $colleagueA->id);
    }

    public function test_leader_watches_only_granted_sites_as_hidden_viewer(): void
    {
        $orgA = Organization::factory()->create();
        $orgB = Organization::factory()->create();
        $leader = $this->leaderWithAccessTo($orgA);

        $response = $this->actingAs($leader, 'sanctum')
            ->postJson('/api/v1/live/watch-token', ['organization_id' => $orgA->id])
            ->assertOk();

        $claims = $this->decodeLiveKitToken($response->json('data.token'));
        $this->assertSame("site-{$orgA->id}", $claims['video']['room']);
        $this->assertFalse($claims['video']['canPublish']);
        $this->assertTrue($claims['video']['hidden']);

        $this->actingAs($leader, 'sanctum')
            ->postJson('/api/v1/live/watch-token', ['organization_id' => $orgB->id])
            ->assertForbidden();

        // leader view-only -- tidak boleh menyiarkan.
        $this->actingAs($leader, 'sanctum')->postJson('/api/v1/live/sessions/start')->assertForbidden();
    }

    public function test_ending_work_closes_session_and_removes_participant(): void
    {
        $org = Organization::factory()->create();
        $staff = $this->staffInOrganization($org);

        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/start')->assertCreated();
        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/end')->assertOk();

        $this->assertSame('manual', WorkSession::where('user_id', $staff->id)->first()->end_reason);
        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/heartbeat')->assertNotFound();

        Http::assertSent(fn ($request) => str_ends_with($request->url(), '/twirp/livekit.RoomService/RemoveParticipant')
            && $request['room'] === "site-{$org->id}"
            && $request['identity'] === "user-{$staff->id}");
    }

    public function test_stale_sessions_are_closed_by_scheduled_command(): void
    {
        $staff = $this->staffInOrganization(Organization::factory()->create());
        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/start')->assertCreated();

        $this->travel(3)->minutes();
        $this->artisan('work-sessions:close-stale')->assertSuccessful();

        $this->assertSame('timeout', WorkSession::where('user_id', $staff->id)->first()->end_reason);
    }

    public function test_watchable_sites_follow_user_scope(): void
    {
        $orgA = Organization::factory()->create(['is_active' => true]);
        $orgB = Organization::factory()->create(['is_active' => true]);

        $this->actingAs($this->staffInOrganization($orgA), 'sanctum')
            ->getJson('/api/v1/live/sites')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $orgA->id);

        $this->actingAs($this->leaderWithAccessTo($orgB), 'sanctum')
            ->getJson('/api/v1/live/sites')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $orgB->id);
    }

    public function test_staff_gets_latest_successful_live_apk(): void
    {
        $orgA = Organization::factory()->create();
        $orgB = Organization::factory()->create();
        $staff = $this->staffInOrganization($orgA);

        $this->actingAs($staff, 'sanctum')
            ->getJson('/api/v1/live/app')
            ->assertOk()
            ->assertJsonPath('data', null);

        $build = fn (Organization $org, string $type, string $status, string $version) => ApkBuild::create([
            'organization_id' => $org->id,
            'apk_type' => $type,
            'version' => $version,
            'status' => $status,
            'file_path' => $status === 'success' ? "apk-builds/{$org->id}/{$type}-{$version}.apk" : null,
            'embedded_site_code' => 'X',
            'built_by' => $staff->id,
            'created_at' => now(),
        ]);

        // APK Live universal: build dari site lain pun dipakai; gagal & tipe lain diabaikan.
        $build($orgB, 'live', 'success', '1.0.0');
        $build($orgA, 'master', 'success', '9.9.9');
        $build($orgA, 'live', 'failed', '2.0.0');

        $response = $this->actingAs($staff, 'sanctum')
            ->getJson('/api/v1/live/app')
            ->assertOk()
            ->assertJsonPath('data.version', '1.0.0');

        $this->assertStringContainsString('signature=', $response->json('data.download_url'));
    }

    public function test_live_apk_requires_broadcast_permission(): void
    {
        $this->actingAs($this->leaderWithAccessTo(Organization::factory()->create()), 'sanctum')
            ->getJson('/api/v1/live/app')
            ->assertForbidden();
    }
}
