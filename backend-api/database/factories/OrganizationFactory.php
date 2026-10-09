<?php

namespace Database\Factories;

use App\Models\Organization;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<Organization>
 */
class OrganizationFactory extends Factory
{
    public function definition(): array
    {
        return [
            'name' => fake()->unique()->company(),
            'type' => 'company_asset',
            'unique_site_code' => 'SITE-'.Str::upper(Str::random(9)),
            'is_active' => true,
        ];
    }
}
