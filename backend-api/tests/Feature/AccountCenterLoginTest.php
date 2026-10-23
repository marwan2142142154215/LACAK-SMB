<?php

namespace Tests\Feature;

use App\Models\User;
use App\Services\AccountCenter;
use App\Services\AesCbc256;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class AccountCenterLoginTest extends TestCase
{
    use RefreshDatabase;

    private const URI = 'https://account-center.test';

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'lacaksmb.account_center.enabled' => true,
            'lacaksmb.account_center.uri' => self::URI,
            'lacaksmb.account_center.name' => 'lacak-smb',
            'lacaksmb.account_center.secret' => 'rahasia-uji-coba',
        ]);
    }

    /**
     * Vektor dari pustaka PHP Account Center yang asli (disalin dari
     * scatter/tests/functional/aes_cbc_256.spec.ts). Kalau gagal, login
     * Account Center akan ditolak "tanda tangan tidak sah" -- jangan diubah.
     */
    public function test_aes_matches_account_center_library(): void
    {
        $key = AesCbc256::keyFrom('rahasia-uji-coba');
        $iv = '0123456789abcdef';

        $this->assertSame('UjRIaGlQWHRjRVVBOXJ4eGRUdlpQL0FFUTk3bS93UGpEMm9hUzNIQisrOD0=', AesCbc256::encrypt('password-rahasia', $key, $iv));
        $this->assertSame('YUJZaGdCUGxCTXlSR3JMQk5ScW1tUT09', AesCbc256::encrypt('a', $key, $iv));
        $this->assertSame(
            'ekJZck9lQTJORk4rYzNoUHU5SlZnVWJNVFZFWlljUlUzSlNCbDdac1R2N3FaRmtrejVPbFBOdTQ3K0dXMnJrUQ==',
            AesCbc256::encrypt('{"email":"a@b.c","password":"XYZ"}', $key, $iv)
        );
        $this->assertMatchesRegularExpression('/^[0-9a-f]{16}$/', AesCbc256::generateIv());
    }

    public function test_unreadable_or_failed_answers_are_rejected(): void
    {
        foreach ([null, 'sukses', 42, [], ['token' => 'abc'], ['data' => ['id' => 7]]] as $payload) {
            $this->assertSame(AccountCenter::REJECTED, AccountCenter::readIdentity($payload)['state']);
        }

        $this->assertSame(AccountCenter::REJECTED, AccountCenter::readIdentity(['success' => false, 'data' => ['email' => 'a@b.c']])['state']);
        $this->assertSame(AccountCenter::REJECTED, AccountCenter::readIdentity(['status' => 'error', 'email' => 'a@b.c'])['state']);

        $identity = AccountCenter::readIdentity(['success' => true, 'data' => ['email' => 'Orang@Contoh.test', 'name' => 'Orang']]);
        $this->assertSame(AccountCenter::AUTHENTICATED, $identity['state']);
        $this->assertSame('orang@contoh.test', $identity['email']);
    }

    public function test_email_login_goes_through_account_center_and_still_requires_2fa(): void
    {
        $user = User::factory()->create(['email' => 'staf@perusahaan.test', 'password' => 'password-lokal-lain']);

        Http::fake([self::URI.'/auth/login' => Http::response(['success' => true, 'data' => ['email' => 'Staf@Perusahaan.test']])]);

        $response = $this->postJson('/api/v1/auth/login', ['username' => 'Staf@Perusahaan.test', 'password' => 'password-ac']);

        $response->assertOk()
            ->assertJsonPath('data.requires_2fa', true)
            ->assertJsonMissingPath('data.access_token');
        $this->assertSame(0, $user->tokens()->count());

        Http::assertSent(function (Request $request) {
            $key = AesCbc256::keyFrom('rahasia-uji-coba');
            $iv = base64_decode($request->header('X-Client-Iv')[0]);

            return $request->header('X-Client-Id')[0] === 'lacak-smb'
                && AesCbc256::decrypt($request->header('Signature')[0], $key, $iv) === $request->body()
                && AesCbc256::decrypt($request['password'], $key, $iv) === 'password-ac'
                && $request['email'] === 'staf@perusahaan.test';
        });
    }

    public function test_account_center_rejection_and_outage_do_not_log_in(): void
    {
        User::factory()->create(['email' => 'staf@perusahaan.test']);

        Http::fake([self::URI.'/auth/login' => Http::sequence()->push(['message' => 'salah'], 401)->push([], 503)]);

        $this->postJson('/api/v1/auth/login', ['username' => 'staf@perusahaan.test', 'password' => 'x'])->assertStatus(401);
        $this->postJson('/api/v1/auth/login', ['username' => 'staf@perusahaan.test', 'password' => 'x'])->assertStatus(503);
    }

    public function test_account_center_identity_without_local_account_is_refused(): void
    {
        Http::fake([self::URI.'/auth/login' => Http::response(['email' => 'orang-luar@perusahaan.test'])]);

        $this->postJson('/api/v1/auth/login', ['username' => 'orang-luar@perusahaan.test', 'password' => 'x'])
            ->assertForbidden()
            ->assertJsonMissingPath('data.access_token');
    }

    public function test_root_account_must_set_up_2fa_like_everyone_else(): void
    {
        $this->app['env'] = 'local';
        User::factory()->create(['username' => 'root', 'password' => 'Root12345!', 'two_factor_confirmed_at' => null]);

        $this->postJson('/api/v1/auth/login', ['username' => 'root', 'password' => 'Root12345!'])
            ->assertOk()
            ->assertJsonPath('data.requires_2fa_setup', true)
            ->assertJsonMissingPath('data.access_token');
    }
}
