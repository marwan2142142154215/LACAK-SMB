<?php

use App\Models\ConsentDocument;
use App\Models\Device;
use App\Models\GeofenceRule;
use App\Models\Organization;
use App\Models\User;
use Database\Seeders\RolesAndPermissionsSeeder;

beforeEach(function () {
    $this->seed(RolesAndPermissionsSeeder::class);
});

function makeDeviceInOrganization(Organization $org): Device
{
    return Device::factory()->create([
        'organization_id' => $org->id,
        'consent_document_id' => ConsentDocument::factory()->create(['organization_id' => $org->id])->id,
    ]);
}

/**
 * Regresi dari audit keamanan menyeluruh: 'exists:devices,id' saja cuma
 * mengecek device-nya ADA, bukan device-nya milik site yang sama dengan
 * aturan geofence -- admin site A bisa tanam anchor_device_id milik site
 * B, dan nama device B bocor lewat GeofenceRuleResource.
 */
test('site_admin TIDAK BISA pakai device org lain sebagai anchor saat membuat aturan', function () {
    $orgA = Organization::factory()->create();
    $orgB = Organization::factory()->create();
    $deviceOfOrgB = makeDeviceInOrganization($orgB);

    $admin = User::factory()->create(['organization_id' => $orgA->id]);
    $admin->assignRole('site_admin');

    $this->actingAs($admin, 'sanctum')
        ->postJson('/api/v1/geofence-rules', [
            'organization_id' => $orgA->id,
            'rule_name' => 'Kantor Utama',
            'anchor_device_id' => $deviceOfOrgB->id,
        ])->assertStatus(422);

    expect(GeofenceRule::where('rule_name', 'Kantor Utama')->exists())->toBeFalse();
});

test('site_admin TIDAK BISA ganti anchor ke device org lain saat update', function () {
    $orgA = Organization::factory()->create();
    $orgB = Organization::factory()->create();
    $deviceOfOrgB = makeDeviceInOrganization($orgB);
    $rule = GeofenceRule::factory()->create(['organization_id' => $orgA->id]);

    $admin = User::factory()->create(['organization_id' => $orgA->id]);
    $admin->assignRole('site_admin');

    $this->actingAs($admin, 'sanctum')
        ->putJson("/api/v1/geofence-rules/{$rule->id}", [
            'anchor_device_id' => $deviceOfOrgB->id,
        ])->assertStatus(422);

    expect($rule->fresh()->anchor_device_id)->toBeNull();
});

test('site_admin BISA pakai device org sendiri sebagai anchor', function () {
    $org = Organization::factory()->create();
    $device = makeDeviceInOrganization($org);

    $admin = User::factory()->create(['organization_id' => $org->id]);
    $admin->assignRole('site_admin');

    $this->actingAs($admin, 'sanctum')
        ->postJson('/api/v1/geofence-rules', [
            'organization_id' => $org->id,
            'rule_name' => 'Kantor Utama',
            'anchor_device_id' => $device->id,
        ])->assertCreated();
});
