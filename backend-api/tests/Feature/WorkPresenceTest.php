<?php

namespace Tests\Feature;

use App\Models\Organization;
use App\Models\User;
use App\Models\WorkSession;
use App\Models\WorkSessionEvent;
use App\Support\TwoFactorPolicy;
use Database\Seeders\RolesAndPermissionsSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class WorkPresenceTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed(RolesAndPermissionsSeeder::class);

        config([
            'lacaksmb.livekit.url' => 'wss://live.test',
            'lacaksmb.livekit.api_key' => 'test-key',
            'lacaksmb.livekit.api_secret' => 'test-secret-yang-cukup-panjang-untuk-hs256',
        ]);

        Http::fake(['live.test/*' => Http::response([], 200)]);
    }

    private function staffIn(Organization $org): User
    {
        $user = User::factory()->create(['organization_id' => $org->id, 'password' => bcrypt('password-benar')]);
        $user->assignRole('staff_viewer');

        return $user;
    }

    /** @return list<array{0: string, 1: string}> */
    private function loggedEvents(User $user): array
    {
        return WorkSessionEvent::where('user_id', $user->id)->orderBy('id')->get()
            ->map(fn (WorkSessionEvent $event) => [$event->type, $event->status])
            ->all();
    }

    public function test_state_changes_are_logged_with_the_resulting_status(): void
    {
        $staff = $this->staffIn(Organization::factory()->create());
        $this->actingAs($staff, 'sanctum');

        $this->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])->assertCreated();
        $this->postJson('/api/v1/live/sessions/heartbeat', ['camera_active' => true])->assertJsonPath('data.status', 'screen_off');
        $this->postJson('/api/v1/live/sessions/heartbeat', ['screen_active' => true])->assertJsonPath('data.status', 'working');
        // Heartbeat tanpa perubahan tidak menambah log.
        $this->postJson('/api/v1/live/sessions/heartbeat')->assertOk();
        $this->postJson('/api/v1/live/sessions/heartbeat', ['on_break' => true])->assertJsonPath('data.status', 'break');
        $this->postJson('/api/v1/live/sessions/heartbeat', ['on_break' => false, 'idle' => true])->assertJsonPath('data.status', 'idle');
        $this->postJson('/api/v1/live/sessions/end')->assertOk();

        $this->assertSame([
            ['work_start', 'camera_off'],
            ['camera_start', 'screen_off'],
            ['screen_start', 'working'],
            ['break_start', 'break'],
            ['break_end', 'working'],
            ['idle_start', 'idle'],
            ['screen_stop', 'screen_off'],
            ['camera_stop', 'camera_off'],
            ['work_end', 'offline'],
        ], $this->loggedEvents($staff));
    }

    public function test_roster_lists_every_site_staff_with_status(): void
    {
        $org = Organization::factory()->create();
        $working = $this->staffIn($org);
        $offline = $this->staffIn($org);
        $this->staffIn(Organization::factory()->create()); // site lain, tidak ikut

        $this->actingAs($working, 'sanctum')->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])->assertCreated();
        $this->actingAs($working, 'sanctum')->postJson('/api/v1/live/sessions/heartbeat', ['camera_active' => true, 'screen_active' => true]);

        $roster = collect($this->actingAs($offline, 'sanctum')->getJson('/api/v1/live/sessions')->assertOk()->json('data.roster'))
            ->pluck('status', 'user_id');

        $this->assertEquals([$working->id => 'working', $offline->id => 'offline'], $roster->all());
    }

    public function test_overview_covers_only_the_sites_a_viewer_may_watch(): void
    {
        $orgA = Organization::factory()->create(['is_active' => true]);
        $orgB = Organization::factory()->create(['is_active' => true]);
        $orgC = Organization::factory()->create(['is_active' => true]);
        $staffA = $this->staffIn($orgA);
        $staffB = $this->staffIn($orgB);
        $staffC = $this->staffIn($orgC);

        foreach ([$staffA, $staffB, $staffC] as $staff) {
            $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])->assertCreated();
        }

        $leader = User::factory()->create(['organization_id' => null]);
        $leader->assignRole('leader');
        $leader->siteAccess()->attach([$orgA->id, $orgB->id]);

        $data = $this->actingAs($leader, 'sanctum')->getJson('/api/v1/live/overview')->assertOk()->json('data');

        $this->assertEqualsCanonicalizing([$orgA->id, $orgB->id], array_column($data['sites'], 'id'));
        $this->assertEqualsCanonicalizing([$staffA->id, $staffB->id], array_column($data['items'], 'user_id'));
        $this->assertEqualsCanonicalizing([$staffA->id, $staffB->id], array_column($data['roster'], 'user_id'));
        // actingAs tanpa token login -> tidak tercatat login dari perangkat mana pun.
        $this->assertSame([null, null], array_column($data['roster'], 'login_device'));

        // Staf biasa hanya melihat site-nya sendiri.
        $this->assertSame([$orgA->id], array_column(
            $this->actingAs($staffA, 'sanctum')->getJson('/api/v1/live/overview')->json('data.sites'),
            'id',
        ));
    }

    public function test_missed_heartbeats_log_disconnect_and_reconnect(): void
    {
        $staff = $this->staffIn(Organization::factory()->create());
        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])->assertCreated();
        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/heartbeat', ['camera_active' => true, 'screen_active' => true]);

        $this->travel(80)->seconds();
        $this->artisan('work-sessions:close-stale')->assertSuccessful();
        $this->artisan('work-sessions:close-stale')->assertSuccessful(); // tidak dicatat dua kali

        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/live/sessions/heartbeat')->assertJsonPath('data.status', 'working');

        $this->assertSame([['disconnected', 'disconnected'], ['reconnected', 'working']], array_slice($this->loggedEvents($staff), -2));
    }

    public function test_alert_when_camera_and_screen_stay_off_after_grace_period(): void
    {
        $staff = $this->staffIn(Organization::factory()->create());
        $this->actingAs($staff, 'sanctum');

        $this->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])->assertJsonPath('data.session.status', 'camera_off');

        $this->travel(61)->seconds();
        $this->postJson('/api/v1/live/sessions/heartbeat')->assertJsonPath('data.status', 'alert');
        $this->postJson('/api/v1/live/sessions/heartbeat', ['camera_active' => true])->assertJsonPath('data.status', 'screen_off');
    }

    public function test_actual_work_hours_exclude_breaks(): void
    {
        $org = Organization::factory()->create();
        $staff = $this->staffIn($org);
        $from = now()->startOfHour();
        $this->travelTo($from->copy()->addMinutes(5));
        $this->actingAs($staff, 'sanctum');

        $this->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])->assertCreated();
        $this->postJson('/api/v1/live/sessions/heartbeat', ['camera_active' => true, 'screen_active' => true]);
        $this->travel(60)->minutes();
        $this->postJson('/api/v1/live/sessions/heartbeat', ['on_break' => true]);
        $this->travel(30)->minutes();
        $this->postJson('/api/v1/live/sessions/heartbeat', ['on_break' => false]);
        $this->travel(15)->minutes();
        $this->postJson('/api/v1/live/sessions/end')->assertOk();

        $response = $this->getJson('/api/v1/live/activity?'.http_build_query([
            'from' => $from->toIso8601String(),
            'to' => $from->copy()->addDay()->toIso8601String(),
        ]))->assertOk();

        $this->assertSame(75 * 60, $response->json('data.summary.0.work_seconds'));
        $this->assertSame(30 * 60, $response->json('data.summary.0.break_seconds'));
        $this->assertSame('offline', $response->json('data.summary.0.status'));
        $this->assertCount(8, $response->json('data.events'));
    }

    public function test_activity_across_all_watchable_sites_with_initial_statuses(): void
    {
        $orgA = Organization::factory()->create(['is_active' => true]);
        $orgB = Organization::factory()->create(['is_active' => true]);
        $orgC = Organization::factory()->create(['is_active' => true]);
        $staffA = $this->staffIn($orgA);
        $staffC = $this->staffIn($orgC);

        // Mulai kerja kemarin -> status sebelum rentang "hari ini" dimulai.
        $this->travelTo(now()->startOfDay()->subHours(2));
        $this->actingAs($staffA, 'sanctum')->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])->assertCreated();
        $this->actingAs($staffA, 'sanctum')->postJson('/api/v1/live/sessions/heartbeat', ['camera_active' => true, 'screen_active' => true]);
        $this->actingAs($staffC, 'sanctum')->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])->assertCreated();
        $this->travelBack();
        $this->actingAs($staffA, 'sanctum')->postJson('/api/v1/live/sessions/heartbeat', ['on_break' => true]);

        $leader = User::factory()->create(['organization_id' => null]);
        $leader->assignRole('leader');
        $leader->siteAccess()->attach([$orgA->id, $orgB->id]);

        $data = $this->actingAs($leader, 'sanctum')
            ->getJson('/api/v1/live/activity?'.http_build_query([
                'all_sites' => 1,
                'from' => now()->startOfDay()->toIso8601String(),
                'to' => now()->endOfDay()->toIso8601String(),
            ]))
            ->assertOk()
            ->json('data');

        // Site C tidak boleh ditonton leader ini -> tidak ikut sama sekali.
        $this->assertSame(['working'], array_values($data['initial_statuses']));
        $this->assertSame([$staffA->id], array_unique(array_column($data['events'], 'user_id')));
        $this->assertSame($orgA->id, $data['events'][0]['organization_id']);
        $this->assertSame($orgA->id, $data['summary'][0]['organization_id']);
    }

    public function test_activity_log_is_limited_to_watchable_sites(): void
    {
        $staffA = $this->staffIn(Organization::factory()->create());
        $orgB = Organization::factory()->create();

        $this->actingAs($staffA, 'sanctum')
            ->getJson('/api/v1/live/activity?'.http_build_query([
                'organization_id' => $orgB->id,
                'from' => now()->startOfDay()->toIso8601String(),
                'to' => now()->endOfDay()->toIso8601String(),
            ]))
            ->assertForbidden();
    }

    public function test_login_and_logout_are_logged_and_logout_ends_work(): void
    {
        TwoFactorPolicy::setRequired(false);
        $staff = $this->staffIn(Organization::factory()->create());

        $token = $this->postJson('/api/v1/auth/login', ['username' => $staff->username, 'password' => 'password-benar'])
            ->assertOk()
            ->json('data.access_token');

        $this->withToken($token)->postJson('/api/v1/live/sessions/start', ['device' => 'computer'])->assertCreated();
        $this->withToken($token)->postJson('/api/v1/auth/logout')->assertOk();

        $this->assertSame(0, WorkSession::open()->where('user_id', $staff->id)->count());
        $this->assertSame(
            [['login', 'offline'], ['work_start', 'camera_off'], ['work_end', 'offline'], ['logout', 'offline']],
            $this->loggedEvents($staff),
        );
    }
}
