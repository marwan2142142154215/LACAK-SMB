<?php

namespace Database\Factories;

use App\Models\ConsentDocument;
use App\Models\Organization;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<ConsentDocument>
 */
class ConsentDocumentFactory extends Factory
{
    public function definition(): array
    {
        return [
            'organization_id' => Organization::factory(),
            'subject_name' => fake()->name(),
            'signer_name' => fake()->name(),
            'signer_role' => 'pemilik',
            'document_file_path' => 'consent-documents/'.fake()->uuid().'.pdf',
            'signed_at' => now()->subDay(),
            'valid_until' => null,
            'revoked_at' => null,
            'created_by' => User::factory(),
        ];
    }

    public function revoked(): static
    {
        return $this->state(fn () => ['revoked_at' => now()]);
    }
}
