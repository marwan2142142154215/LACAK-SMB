<?php

use App\Models\ConsentDocument;
use App\Models\Device;
use App\Models\Organization;
use App\Models\User;
use Database\Seeders\RolesAndPermissionsSeeder;

beforeEach(function () {
    $this->seed(RolesAndPermissionsSeeder::class);
});

function makeDeviceInOrg(Organization $org): Device
{
    return Device::factory()->create([
        'organization_id' => $org->id,
        'consent_document_id' => ConsentDocument::factory()->create(['organization_id' => $org->id])->id,
    ]);
}

test('site_admin bisa lock device milik org sendiri', function () {
    $org = Organization::factory()->create();
    $device = makeDeviceInOrg($org);

    $admin = User::factory()->create(['organization_id' => $org->id]);
    $admin->assignRole('site_admin');

    $this->actingAs($admin, 'sanctum')
        ->postJson("/api/v1/devices/{$device->id}/commands", [
            'command_type' => 'lock',
            'issued_via' => 'web_dashboard',
        ])->assertCreated();

    expect($device->fresh()->status)->toBe('locked');
});

/**
 * Regresi langsung dari Vuln 3 (security review): site_admin site A
 * TIDAK boleh bisa lock/unlock device milik site B lewat endpoint yang
 * sama persis dipakai bot Telegram (lihat DeviceCommandController).
 */
test('site_admin TIDAK BISA lock device milik org lain', function () {
    $orgA = Organization::factory()->create();
    $orgB = Organization::factory()->create();
    $deviceOfOrgB = makeDeviceInOrg($orgB);

    $adminOfOrgA = User::factory()->create(['organization_id' => $orgA->id]);
    $adminOfOrgA->assignRole('site_admin');

    $this->actingAs($adminOfOrgA, 'sanctum')
        ->postJson("/api/v1/devices/{$deviceOfOrgB->id}/commands", [
            'command_type' => 'lock',
            'issued_via' => 'web_dashboard',
        ])->assertForbidden();

    expect($deviceOfOrgB->fresh()->status)->not->toBe('locked');
});

test('super_admin bisa lock device site mana pun', function () {
    $org = Organization::factory()->create();
    $device = makeDeviceInOrg($org);

    $superAdmin = User::factory()->create(['organization_id' => null]);
    $superAdmin->assignRole('super_admin');

    $this->actingAs($superAdmin, 'sanctum')
        ->postJson("/api/v1/devices/{$device->id}/commands", [
            'command_type' => 'lock',
            'issued_via' => 'web_dashboard',
        ])->assertCreated();
});

test('staff_viewer (view-only) tidak bisa lock device sama sekali', function () {
    $org = Organization::factory()->create();
    $device = makeDeviceInOrg($org);

    $viewer = User::factory()->create(['organization_id' => $org->id]);
    $viewer->assignRole('staff_viewer');

    $this->actingAs($viewer, 'sanctum')
        ->postJson("/api/v1/devices/{$device->id}/commands", [
            'command_type' => 'lock',
            'issued_via' => 'web_dashboard',
        ])->assertForbidden();
});

test('unlock tetap diizinkan walau consent sudah dicabut, lock tidak', function () {
    $org = Organization::factory()->create();
    $consent = ConsentDocument::factory()->revoked()->create(['organization_id' => $org->id]);
    $device = Device::factory()->create([
        'organization_id' => $org->id,
        'consent_document_id' => $consent->id,
        'status' => 'locked',
    ]);

    $admin = User::factory()->create(['organization_id' => $org->id]);
    $admin->assignRole('site_admin');

    $this->actingAs($admin, 'sanctum')
        ->postJson("/api/v1/devices/{$device->id}/commands", [
            'command_type' => 'lock',
            'issued_via' => 'web_dashboard',
        ])->assertStatus(422);

    $this->actingAs($admin, 'sanctum')
        ->postJson("/api/v1/devices/{$device->id}/commands", [
            'command_type' => 'unlock',
            'issued_via' => 'web_dashboard',
        ])->assertCreated();
});
