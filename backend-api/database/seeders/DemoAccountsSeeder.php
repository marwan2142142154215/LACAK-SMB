<?php

namespace Database\Seeders;

use App\Models\Organization;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Akun & site dummy untuk SERVER UJI -- tidak ikut DatabaseSeeder, hanya
 * jalan kalau dipanggil eksplisit:
 *
 *   php artisan db:seed --class=DemoAccountsSeeder --force
 *
 * Semua akun memakai satu password: dari env DEMO_ACCOUNTS_PASSWORD kalau
 * diisi, kalau tidak dibuat acak dan dicetak sekali di terminal (tidak
 * pernah ditulis di kode -- repo publik). Menjalankan ulang seeder ini
 * mereset password semua akun dummy ke password baru -- isi
 * DEMO_ACCOUNTS_PASSWORD dengan password lama supaya tidak berubah.
 */
class DemoAccountsSeeder extends Seeder
{
    /** @var array<int, array{0: string, 1: string, 2: string, 3: string|null, 4: array<int, string>}> */
    private const ACCOUNTS = [
        // username, nama, peran, site (organization_id), akses site (admin/leader)
        ['root', 'Root (uji)', 'super_admin', null, []],
        ['admin.uji', 'Admin Uji', 'admin', null, ['A', 'B']],
        ['leader.uji', 'Leader Uji', 'leader', null, ['A', 'B']],
        ['siteadmin.a', 'Admin Site A', 'site_admin', 'A', []],
        ['staf.a1', 'Staf A1', 'staff_viewer', 'A', []],
        ['staf.a2', 'Staf A2', 'staff_viewer', 'A', []],
        ['staf.b1', 'Staf B1', 'staff_viewer', 'B', []],
    ];

    /** Staf tambahan per site, untuk menguji dinding Live Kerja & log kerja dengan banyak orang. */
    private const EXTRA_STAFF = ['A' => [3, 262], 'B' => [2, 11]];

    /** Root tambahan (super_admin) selain `root`: root2, root3. */
    private const EXTRA_ROOTS = [2, 3];

    /** Akun admin tim audit LC: auditlc1 - auditlc10, akses Site Uji A & B. */
    private const AUDITLC_ADMINS = [1, 10];

    /** Akun leader: leader1 - leader20, menonton Site Uji A & B. */
    private const EXTRA_LEADERS = [1, 20];

    /** @return array<int, array{0: string, 1: string, 2: string, 3: string|null, 4: array<int, string>}> */
    private function accounts(): array
    {
        $accounts = self::ACCOUNTS;

        foreach (self::EXTRA_ROOTS as $number) {
            $accounts[] = ["root{$number}", "Root {$number} (uji)", 'super_admin', null, []];
        }

        foreach (range(...self::AUDITLC_ADMINS) as $number) {
            $accounts[] = ["auditlc{$number}", "Audit LC {$number}", 'admin', null, ['A', 'B']];
        }

        foreach (range(...self::EXTRA_LEADERS) as $number) {
            $accounts[] = ["leader{$number}", "Leader {$number}", 'leader', null, ['A', 'B']];
        }

        foreach (self::EXTRA_STAFF as $siteKey => [$from, $to]) {
            foreach (range($from, $to) as $number) {
                $code = Str::lower($siteKey).$number;
                $accounts[] = ["staf.{$code}", 'Staf '.Str::upper($code), 'staff_viewer', $siteKey, []];
            }
        }

        return $accounts;
    }

    public function run(): void
    {
        $this->call(RolesAndPermissionsSeeder::class);

        $sites = [
            'A' => $this->site('Site Uji A'),
            'B' => $this->site('Site Uji B'),
        ];

        $password = env('DEMO_ACCOUNTS_PASSWORD') ?: 'Uji-'.Str::random(10);
        // Satu hash untuk semua akun (passwordnya sama): bcrypt ratusan kali
        // makan beberapa menit di server. Cast 'hashed' di model User tidak
        // meng-hash ulang nilai yang sudah berupa hash.
        $passwordHash = Hash::make($password);

        foreach ($this->accounts() as [$username, $name, $role, $siteKey, $access]) {
            // withTrashed: akun dummy yang pernah dihapus dihidupkan lagi,
            // bukan dibuat ulang (username tetap unik walau soft-deleted).
            $user = User::withTrashed()->updateOrCreate(['username' => $username], [
                'name' => $name,
                'email' => "{$username}@uji.salahmu.fun",
                'password' => $passwordHash,
                'organization_id' => $siteKey ? $sites[$siteKey]->id : null,
                'is_active' => true,
            ]);
            $user->trashed() && $user->restore();
            $user->syncRoles([$role]);
            $user->siteAccess()->sync(array_map(fn ($key) => $sites[$key]->id, $access));
        }

        $this->command?->newLine();
        $this->command?->warn('Akun dummy server uji (password sama untuk semua, hanya ditampilkan sekali):');
        $this->command?->table(
            ['Username', 'Peran', 'Site'],
            array_map(fn ($account) => [
                $account[0],
                $account[2],
                $account[3] ? "Site Uji {$account[3]}" : ($account[4] ? 'Akses: Site Uji '.implode(' & ', $account[4]) : 'Semua site'),
            ], $this->accounts()),
        );
        $this->command?->line("Password: {$password}");
        $this->command?->newLine();
    }

    private function site(string $name): Organization
    {
        return Organization::firstOrCreate(['name' => $name], [
            'type' => 'company_asset',
            'unique_site_code' => 'UJI-'.Str::upper(Str::random(8)),
            'is_active' => true,
        ]);
    }
}
