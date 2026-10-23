<?php

namespace App\Console\Commands;

use App\Support\TwoFactorPolicy;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

/**
 * Menyalakan/mematikan kewajiban 2FA dari server -- untuk server uji, atau
 * saat super_admin terkunci dan tidak bisa membuka halaman Pengaturan.
 */
#[Signature('security:two-factor {state? : on = wajib 2FA, off = login cukup password}')]
#[Description('Lihat atau ubah apakah 2FA wajib saat login')]
class SetTwoFactorRequirement extends Command
{
    public function handle(): int
    {
        $state = $this->argument('state');

        if ($state === null) {
            $this->line('2FA saat login: '.(TwoFactorPolicy::isRequired() ? 'WAJIB (on)' : 'TIDAK wajib (off)'));

            return self::SUCCESS;
        }

        if (! in_array($state, ['on', 'off'], true)) {
            $this->error('Isi dengan "on" atau "off".');

            return self::FAILURE;
        }

        TwoFactorPolicy::setRequired($state === 'on');

        $this->info($state === 'on'
            ? '2FA sekarang WAJIB saat login.'
            : '2FA dimatikan: login cukup username/email + password. Jangan pakai mode ini di server produksi.');

        return self::SUCCESS;
    }
}
