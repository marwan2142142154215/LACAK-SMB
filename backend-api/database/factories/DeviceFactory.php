<?php

namespace Database\Factories;

use App\Models\ConsentDocument;
use App\Models\Device;
use App\Models\Organization;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Device>
 */
class DeviceFactory extends Factory
{
    public function definition(): array
    {
        return [
            'organization_id' => Organization::factory(),
            'consent_document_id' => ConsentDocument::factory(),
            'device_name' => fake()->words(2, true),
            'device_uuid' => fake()->unique()->uuid(),
            'android_version' => '14',
            'app_build_version' => '1.0.0',
            'site_code_embedded' => 'SITE-'.fake()->bothify('???????###'),
            'status' => 'online',
            'battery_level' => fake()->numberBetween(10, 100),
            'enrolled_at' => now(),
            'is_active' => true,
        ];
    }
}
