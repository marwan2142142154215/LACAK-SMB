<?php

namespace Database\Factories;

use App\Models\TelegramUserLink;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<TelegramUserLink>
 */
class TelegramUserLinkFactory extends Factory
{
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'telegram_user_id' => (string) fake()->unique()->numberBetween(100000000, 999999999),
            'telegram_username' => fake()->userName(),
        ];
    }
}
