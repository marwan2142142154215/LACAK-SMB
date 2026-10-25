<?php

use App\Models\Organization;
use App\Models\User;
use Database\Seeders\RolesAndPermissionsSeeder;

beforeEach(function () {
    $this->seed(RolesAndPermissionsSeeder::class);
});

function summaryStaffIn(Organization $org): User
{
    $user = User::factory()->create(['organization_id' => $org->id]);
    $user->assignRole('staff_viewer');

    return $user;
}

test('ringkasan dashboard menghitung staf dan staf online (masih login) di site sendiri', function () {
    $org = Organization::factory()->create();
    $online = summaryStaffIn($org);
    $expired = summaryStaffIn($org);
    summaryStaffIn($org); // tidak pernah login
    $viewer = summaryStaffIn($org);
    summaryStaffIn(Organization::factory()->create())->createToken('web_dashboard-1', ['*'], now()->addHour()); // site lain

    $online->createToken('web_dashboard-1', ['*'], now()->addHours(2));
    $expired->createToken('web_dashboard-1', ['*'], now()->subMinute());

    $this->actingAs($viewer, 'sanctum')
        ->getJson('/api/v1/dashboard-summary')
        ->assertOk()
        ->assertJsonPath('data.staff_count', 4)
        ->assertJsonPath('data.staff_online_count', 1);
});
