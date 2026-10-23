<?php

namespace App\Support;

use App\Models\AppSetting;
use App\Models\User;

/**
 * Wajib/tidaknya 2FA saat login. Bawaannya WAJIB -- hanya super_admin yang
 * bisa mematikannya (dashboard Pengaturan atau `php artisan security:two-factor`),
 * mis. untuk server uji. Saat dimatikan, login cukup username/email +
 * password; secret 2FA yang sudah terpasang tetap tersimpan, jadi begitu
 * dinyalakan lagi staf langsung memakai authenticator yang sama.
 */
class TwoFactorPolicy
{
    public const SETTING_KEY = 'auth.two_factor_required';

    public static function isRequired(): bool
    {
        return (bool) AppSetting::get(self::SETTING_KEY, true);
    }

    public static function setRequired(bool $required, ?User $changedBy = null): void
    {
        AppSetting::put(self::SETTING_KEY, $required, $changedBy);
    }
}
