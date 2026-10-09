<?php

namespace Database\Factories;

use App\Models\GeofenceRule;
use App\Models\Organization;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<GeofenceRule>
 */
class GeofenceRuleFactory extends Factory
{
    public function definition(): array
    {
        return [
            'organization_id' => Organization::factory(),
            'rule_name' => fake()->words(2, true),
            'max_distance_meters' => 50,
            'center_latitude' => fake()->latitude(),
            'center_longitude' => fake()->longitude(),
            'is_active' => true,
        ];
    }
}
