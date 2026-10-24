<?php

use App\Jobs\RecordQueueHeartbeat;
use App\Models\User;
use App\Services\ServerStatus;
use Database\Seeders\RolesAndPermissionsSeeder;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    $this->seed(RolesAndPermissionsSeeder::class);
    config([
        'lacaksmb.status.gateway_url' => 'http://gateway.test',
        'lacaksmb.status.livekit_url' => 'http://livekit.test',
    ]);
});

function statusUser(string $role): User
{
    $user = User::factory()->create();
    $user->assignRole($role);

    return $user;
}

/** @return array<string, array<string, mixed>> */
function servicesByKey(array $data): array
{
    return collect($data['services'])->keyBy('key')->all();
}

test('hanya super_admin yang boleh melihat status server', function () {
    Http::fake();

    foreach (['staff_viewer', 'site_admin', 'admin', 'leader'] as $role) {
        $this->actingAs(statusUser($role), 'sanctum')->getJson('/api/v1/system/status')->assertForbidden();
    }

    $this->actingAs(statusUser('super_admin'), 'sanctum')->getJson('/api/v1/system/status')->assertOk();
});

test('gateway & livekit yang menjawab normal berstatus ok, yang mati berstatus down', function () {
    Http::fake([
        'gateway.test*' => Http::response(['success' => true, 'data' => ['status' => 'ok']]),
        'livekit.test*' => Http::response('', 502),
    ]);

    $data = $this->actingAs(statusUser('super_admin'), 'sanctum')->getJson('/api/v1/system/status')->assertOk()->json('data');
    $services = servicesByKey($data);

    expect($services['api']['status'])->toBe('ok')
        ->and($services['database']['status'])->toBe('ok')
        ->and($services['cache']['status'])->toBe('ok')
        ->and($services['gateway']['status'])->toBe('ok')
        ->and($services['livekit']['status'])->toBe('down')
        ->and($data['overall'])->toBe('down');
});

test('scheduler & antrean dinilai dari detak terakhirnya', function () {
    Http::fake(['*' => Http::response(['data' => ['status' => 'ok']])]);
    $admin = statusUser('super_admin');

    $services = servicesByKey($this->actingAs($admin, 'sanctum')->getJson('/api/v1/system/status')->json('data'));
    expect($services['scheduler']['status'])->toBe('unknown')
        ->and($services['queue']['status'])->toBe('unknown');

    ServerStatus::recordSchedulerHeartbeat();
    (new RecordQueueHeartbeat)->handle();

    $services = servicesByKey($this->actingAs($admin, 'sanctum')->getJson('/api/v1/system/status')->json('data'));
    expect($services['scheduler']['status'])->toBe('ok')
        ->and($services['queue']['status'])->toBe('ok');

    $this->travel(5)->minutes();
    $services = servicesByKey($this->actingAs($admin, 'sanctum')->getJson('/api/v1/system/status')->json('data'));
    expect($services['scheduler']['status'])->toBe('warn');

    $this->travel(10)->minutes();
    $services = servicesByKey($this->actingAs($admin, 'sanctum')->getJson('/api/v1/system/status')->json('data'));
    expect($services['scheduler']['status'])->toBe('down')
        ->and($services['queue']['status'])->toBe('down');
});

test('scheduler mengirim detak scheduler dan job detak antrean tiap menit', function () {
    $events = collect(app(Schedule::class)->events())
        ->map(fn ($event) => $event->description)
        ->all();

    expect($events)->toContain('server-status:scheduler-heartbeat', 'server-status:queue-heartbeat');
});
