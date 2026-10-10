<?php

use App\Jobs\BuildApkJob;
use App\Models\ApkBuild;
use App\Models\ConsentDocument;
use App\Models\Device;
use App\Models\Organization;
use App\Models\User;
use Database\Seeders\RolesAndPermissionsSeeder;
use Illuminate\Support\Facades\Queue;

beforeEach(function () {
    $this->seed(RolesAndPermissionsSeeder::class);
    // BuildApkJob memicu Gradle/WSL sungguhan (QUEUE_CONNECTION=sync di
    // phpunit.xml -- job jalan SINKRON di proses test). Queue::fake()
    // mencegah itu supaya tes ini cuma menguji logika controller (device
    // dibuat + device_secret digenerate), bukan ikut menjalankan build
    // APK sungguhan yang makan waktu 1-2 menit per tes.
    Queue::fake();
});

test('build APK tracker otomatis membuat device dengan device_secret (zero-touch)', function () {
    $org = Organization::factory()->create();
    $consent = ConsentDocument::factory()->create(['organization_id' => $org->id]);

    $admin = User::factory()->create(['organization_id' => $org->id]);
    $admin->assignRole('site_admin');

    $response = $this->actingAs($admin, 'sanctum')
        ->postJson('/api/v1/apk-builds/generate', [
            'organization_id' => $org->id,
            'apk_type' => 'tracker',
            'version' => '1.0.0',
            'device_name' => 'HP Test Zero-Touch',
            'consent_document_id' => $consent->id,
        ])->assertStatus(202);

    $device = Device::where('device_name', 'HP Test Zero-Touch')->first();

    expect($device)->not->toBeNull();
    expect($device->device_uuid)->not->toBeEmpty();
    expect($device->device_secret)->not->toBeEmpty();
    expect(strlen($device->device_secret))->toBe(40);
    expect($device->consent_document_id)->toBe($consent->id);
    expect($device->status)->toBe('pending_enrollment');

    $buildId = $response->json('data.id');
    expect(ApkBuild::find($buildId)->device_id)->toBe($device->id);

    Queue::assertPushed(BuildApkJob::class);
});

test('build APK tracker ditolak kalau consent sudah dicabut', function () {
    $org = Organization::factory()->create();
    $consent = ConsentDocument::factory()->revoked()->create(['organization_id' => $org->id]);

    $admin = User::factory()->create(['organization_id' => $org->id]);
    $admin->assignRole('site_admin');

    $this->actingAs($admin, 'sanctum')
        ->postJson('/api/v1/apk-builds/generate', [
            'organization_id' => $org->id,
            'apk_type' => 'tracker',
            'device_name' => 'HP Test',
            'consent_document_id' => $consent->id,
        ])->assertStatus(422);

    expect(Device::where('device_name', 'HP Test')->exists())->toBeFalse();
});

test('build APK tracker ditolak kalau consent milik site lain', function () {
    $orgA = Organization::factory()->create();
    $orgB = Organization::factory()->create();
    $consentOfOrgB = ConsentDocument::factory()->create(['organization_id' => $orgB->id]);

    $admin = User::factory()->create(['organization_id' => $orgA->id]);
    $admin->assignRole('site_admin');

    $this->actingAs($admin, 'sanctum')
        ->postJson('/api/v1/apk-builds/generate', [
            'organization_id' => $orgA->id,
            'apk_type' => 'tracker',
            'device_name' => 'HP Test',
            'consent_document_id' => $consentOfOrgB->id,
        ])->assertStatus(422);
});

test('build APK master TIDAK membuat device sama sekali', function () {
    $org = Organization::factory()->create();

    $admin = User::factory()->create(['organization_id' => $org->id]);
    $admin->assignRole('site_admin');

    $countBefore = Device::count();

    $this->actingAs($admin, 'sanctum')
        ->postJson('/api/v1/apk-builds/generate', [
            'organization_id' => $org->id,
            'apk_type' => 'master',
            'version' => '1.0.0',
        ])->assertStatus(202);

    expect(Device::count())->toBe($countBefore);
});
