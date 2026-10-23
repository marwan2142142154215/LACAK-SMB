<?php

use App\Models\Organization;
use App\Models\TelegramUserLink;
use App\Models\User;
use Database\Seeders\RolesAndPermissionsSeeder;

beforeEach(function () {
    $this->seed(RolesAndPermissionsSeeder::class);
});

test('super_admin bisa menautkan akun staf lain super_admin (organization_id keduanya null)', function () {
    // Regresi: authorizedOrganizationId() trait mengembalikan null baik
    // untuk "ditolak" maupun untuk "organization_id target memang null"
    // (super_admin tidak terikat satu site) -- ditemukan lewat tes manual
    // sebelum fix: endpoint ini menolak super_admin menautkan sesama
    // super_admin padahal seharusnya diizinkan (lihat canManageStaffLink).
    $actor = User::factory()->create(['organization_id' => null]);
    $actor->assignRole('super_admin');

    $target = User::factory()->create(['organization_id' => null]);
    $target->assignRole('super_admin');

    $this->actingAs($actor, 'sanctum')
        ->postJson('/api/v1/telegram-user-links', [
            'user_id' => $target->id,
            'telegram_user_id' => '555000111',
        ])->assertCreated();

    expect(TelegramUserLink::where('telegram_user_id', '555000111')->exists())->toBeTrue();
});

test('site_admin TIDAK BISA menautkan staf dari site lain', function () {
    $orgA = Organization::factory()->create();
    $orgB = Organization::factory()->create();

    $actor = User::factory()->create(['organization_id' => $orgA->id]);
    $actor->assignRole('site_admin');

    $target = User::factory()->create(['organization_id' => $orgB->id]);
    $target->assignRole('site_admin');

    $this->actingAs($actor, 'sanctum')
        ->postJson('/api/v1/telegram-user-links', [
            'user_id' => $target->id,
            'telegram_user_id' => '555000222',
        ])->assertForbidden();
});

test('lookup balas role & permission akun staf yang ditautkan', function () {
    $org = Organization::factory()->create();
    $staff = User::factory()->create(['organization_id' => $org->id]);
    $staff->assignRole('site_admin');

    TelegramUserLink::factory()->for($staff)->create(['telegram_user_id' => '777000888']);

    $bot = User::factory()->create(['organization_id' => null]);
    $bot->assignRole('telegram_bot_service');

    $response = $this->actingAs($bot, 'sanctum')
        ->getJson('/api/v1/telegram-user-links-lookup?telegram_user_id=777000888')
        ->assertOk();

    expect($response->json('data.permissions'))->toContain('devices.lock');
    expect($response->json('data.roles'))->toContain('site_admin');
});

/**
 * Regresi dari audit keamanan menyeluruh: lookup() sebelumnya cuma
 * mengecek auth:sanctum tanpa role apa pun, jadi staff_viewer (atau
 * siapa pun yang login) bisa query role+permission+
 * accessible_organization_ids staf LAIN lintas organisasi.
 */
test('staff_viewer (bukan bot) TIDAK BISA panggil lookup sama sekali', function () {
    $org = Organization::factory()->create();
    $target = User::factory()->create(['organization_id' => $org->id]);
    $target->assignRole('super_admin');
    TelegramUserLink::factory()->for($target)->create(['telegram_user_id' => '999111222']);

    $viewer = User::factory()->create(['organization_id' => $org->id]);
    $viewer->assignRole('staff_viewer');

    $this->actingAs($viewer, 'sanctum')
        ->getJson('/api/v1/telegram-user-links-lookup?telegram_user_id=999111222')
        ->assertForbidden();
});

test('lookup untuk telegram_user_id yang belum ditautkan balas 404', function () {
    $bot = User::factory()->create(['organization_id' => null]);
    $bot->assignRole('telegram_bot_service');

    $this->actingAs($bot, 'sanctum')
        ->getJson('/api/v1/telegram-user-links-lookup?telegram_user_id=000000000')
        ->assertNotFound();
});
