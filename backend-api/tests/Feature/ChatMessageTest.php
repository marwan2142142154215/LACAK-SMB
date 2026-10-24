<?php

namespace Tests\Feature;

use App\Models\ChatMessage;
use App\Models\Organization;
use App\Models\User;
use Database\Seeders\RolesAndPermissionsSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ChatMessageTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed(RolesAndPermissionsSeeder::class);
    }

    private function staffIn(Organization $org): User
    {
        $user = User::factory()->create(['organization_id' => $org->id]);
        $user->assignRole('staff_viewer');

        return $user;
    }

    public function test_staff_chat_in_their_own_site_and_see_each_other(): void
    {
        $org = Organization::factory()->create();
        $budi = $this->staffIn($org);
        $sari = $this->staffIn($org);

        $this->actingAs($budi, 'sanctum')
            ->postJson('/api/v1/chat/messages', ['body' => '  Halo tim, rapat jam 3  '])
            ->assertCreated()
            ->assertJsonPath('data.organization_id', $org->id)
            ->assertJsonPath('data.user_name', $budi->name)
            ->assertJsonPath('data.body', 'Halo tim, rapat jam 3');

        $this->actingAs($sari, 'sanctum')
            ->getJson('/api/v1/chat/messages')
            ->assertOk()
            ->assertJsonCount(1, 'data.messages')
            ->assertJsonPath('data.messages.0.body', 'Halo tim, rapat jam 3');
    }

    public function test_staff_cannot_read_or_write_another_sites_chat(): void
    {
        $staffA = $this->staffIn(Organization::factory()->create());
        $orgB = Organization::factory()->create();
        ChatMessage::create(['organization_id' => $orgB->id, 'user_id' => $this->staffIn($orgB)->id, 'body' => 'rahasia site B']);

        $this->actingAs($staffA, 'sanctum')
            ->getJson("/api/v1/chat/messages?organization_id={$orgB->id}")
            ->assertForbidden();

        $this->actingAs($staffA, 'sanctum')
            ->postJson('/api/v1/chat/messages', ['organization_id' => $orgB->id, 'body' => 'masuk'])
            ->assertForbidden();

        $this->assertSame(1, ChatMessage::where('organization_id', $orgB->id)->count());
    }

    public function test_leader_chats_only_in_granted_sites(): void
    {
        $orgA = Organization::factory()->create();
        $orgB = Organization::factory()->create();
        $leader = User::factory()->create(['organization_id' => null]);
        $leader->assignRole('leader');
        $leader->siteAccess()->attach($orgA->id);

        $this->actingAs($leader, 'sanctum')
            ->postJson('/api/v1/chat/messages', ['organization_id' => $orgA->id, 'body' => 'Semangat!'])
            ->assertCreated();

        $this->actingAs($leader, 'sanctum')
            ->postJson('/api/v1/chat/messages', ['organization_id' => $orgB->id, 'body' => 'Halo B'])
            ->assertForbidden();
    }

    public function test_empty_or_too_long_messages_are_rejected(): void
    {
        $staff = $this->staffIn(Organization::factory()->create());

        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/chat/messages', ['body' => '   '])->assertStatus(422);
        $this->actingAs($staff, 'sanctum')->postJson('/api/v1/chat/messages', ['body' => str_repeat('a', 1001)])->assertStatus(422);

        $this->assertSame(0, ChatMessage::count());
    }

    public function test_history_is_paginated_oldest_first(): void
    {
        $org = Organization::factory()->create();
        $staff = $this->staffIn($org);

        foreach (range(1, 55) as $number) {
            ChatMessage::create(['organization_id' => $org->id, 'user_id' => $staff->id, 'body' => "pesan {$number}"]);
        }

        $latest = $this->actingAs($staff, 'sanctum')->getJson('/api/v1/chat/messages')->assertOk();

        $this->assertCount(50, $latest->json('data.messages'));
        $this->assertSame('pesan 6', $latest->json('data.messages.0.body'));
        $this->assertSame('pesan 55', $latest->json('data.messages.49.body'));
        $this->assertTrue($latest->json('data.has_more'));

        $older = $this->actingAs($staff, 'sanctum')
            ->getJson('/api/v1/chat/messages?before_id='.$latest->json('data.messages.0.id'))
            ->assertOk();

        $this->assertSame(['pesan 1', 'pesan 2', 'pesan 3', 'pesan 4', 'pesan 5'], array_column($older->json('data.messages'), 'body'));
        $this->assertFalse($older->json('data.has_more'));
    }
}
