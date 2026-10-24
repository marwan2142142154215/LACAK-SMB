<?php

namespace Tests\Feature;

use App\Models\ChatMessage;
use App\Models\Organization;
use App\Models\User;
use Database\Seeders\RolesAndPermissionsSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
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

    private function fakeDocumentsDisk(): void
    {
        config(['filesystems.documents_disk' => 'local']);
        Storage::fake('local');
    }

    public function test_staff_send_image_that_only_their_site_can_open(): void
    {
        $this->fakeDocumentsDisk();
        $org = Organization::factory()->create();
        $budi = $this->staffIn($org);

        $sent = $this->actingAs($budi, 'sanctum')
            ->post('/api/v1/chat/messages', [
                'body' => 'Bukti packing',
                'image' => UploadedFile::fake()->image('packing.jpg', 800, 600),
            ], ['Accept' => 'application/json'])
            ->assertCreated()
            ->assertJsonPath('data.body', 'Bukti packing')
            ->assertJsonPath('data.image.width', 800)
            ->assertJsonPath('data.image.height', 600)
            ->assertJsonMissingPath('data.image_path');

        $message = ChatMessage::findOrFail($sent->json('data.id'));
        Storage::disk('local')->assertExists($message->image_path);
        $this->assertStringStartsWith("chat/{$org->id}/", $message->image_path);

        // Tautan bertanda tangan: bisa dibuka langsung di <img>, sebagai gambar.
        $this->get($sent->json('data.image.url'))
            ->assertOk()
            ->assertHeader('Content-Type', 'image/jpeg')
            ->assertHeader('X-Content-Type-Options', 'nosniff');

        // Tanpa tanda tangan yang sah: ditolak.
        $this->get("/api/v1/chat-messages/{$message->id}/image")->assertForbidden();
    }

    public function test_image_only_message_is_allowed_but_svg_and_empty_messages_are_not(): void
    {
        $this->fakeDocumentsDisk();
        $budi = $this->staffIn(Organization::factory()->create());

        $this->actingAs($budi, 'sanctum')
            ->post('/api/v1/chat/messages', ['image' => UploadedFile::fake()->image('foto.png')], ['Accept' => 'application/json'])
            ->assertCreated()
            ->assertJsonPath('data.body', null);

        $svg = UploadedFile::fake()->createWithContent('x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        $this->actingAs($budi, 'sanctum')
            ->post('/api/v1/chat/messages', ['image' => $svg], ['Accept' => 'application/json'])
            ->assertUnprocessable();

        $this->actingAs($budi, 'sanctum')
            ->postJson('/api/v1/chat/messages', ['body' => '   '])
            ->assertUnprocessable();

        $this->assertSame(1, ChatMessage::count());
    }

    public function test_reply_quotes_the_original_message_in_the_same_site_only(): void
    {
        $org = Organization::factory()->create();
        $budi = $this->staffIn($org);
        $sari = $this->staffIn($org);
        $original = ChatMessage::create(['organization_id' => $org->id, 'user_id' => $budi->id, 'body' => 'Siapa yang pegang kunci gudang?']);

        $this->actingAs($sari, 'sanctum')
            ->postJson('/api/v1/chat/messages', ['body' => 'Saya', 'reply_to_id' => $original->id])
            ->assertCreated()
            ->assertJsonPath('data.reply_to.id', $original->id)
            ->assertJsonPath('data.reply_to.user_name', $budi->name)
            ->assertJsonPath('data.reply_to.body', 'Siapa yang pegang kunci gudang?')
            ->assertJsonPath('data.reply_to.has_image', false);

        $this->actingAs($sari, 'sanctum')
            ->getJson('/api/v1/chat/messages')
            ->assertJsonPath('data.messages.1.reply_to.id', $original->id);

        // Tidak bisa membalas (dan dengan begitu mengutip) pesan site lain.
        $orgB = Organization::factory()->create();
        $secret = ChatMessage::create(['organization_id' => $orgB->id, 'user_id' => $this->staffIn($orgB)->id, 'body' => 'rahasia site B']);
        $this->actingAs($sari, 'sanctum')
            ->postJson('/api/v1/chat/messages', ['body' => 'intip', 'reply_to_id' => $secret->id])
            ->assertUnprocessable();
    }

    public function test_single_message_is_only_visible_to_its_site(): void
    {
        $org = Organization::factory()->create();
        $message = ChatMessage::create(['organization_id' => $org->id, 'user_id' => $this->staffIn($org)->id, 'body' => 'halo']);

        $this->actingAs($this->staffIn($org), 'sanctum')
            ->getJson("/api/v1/chat/messages/{$message->id}")
            ->assertOk()
            ->assertJsonPath('data.body', 'halo');

        $this->actingAs($this->staffIn(Organization::factory()->create()), 'sanctum')
            ->getJson("/api/v1/chat/messages/{$message->id}")
            ->assertForbidden();
    }
}
