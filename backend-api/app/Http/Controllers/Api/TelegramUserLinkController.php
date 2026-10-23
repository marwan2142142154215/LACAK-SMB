<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\TelegramUserLink;
use App\Models\User;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;

/**
 * Tautan akun Telegram pribadi staf -> akun login staf (lihat migration
 * create_telegram_user_links_table). Ditautkan admin dari dashboard: staf
 * kirim /start ke bot dulu supaya telegram_user_id-nya tercatat di log,
 * ATAU admin minta staf teruskan pesan "Forward" dari Telegram yang
 * menampilkan ID-nya -- intinya ID didapat dari Telegram langsung, bukan
 * diketik bebas, supaya tidak salah tautan ke orang lain.
 */
class TelegramUserLinkController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function index(Request $request)
    {
        $request->user()->can('telegram.manage') || abort(403);

        $user = $request->user();

        // telegram_user_links tidak punya organization_id langsung (yang
        // diikat ke tabel ini SIAPA orangnya, bukan site mana) -- scoping-nya
        // lewat organization_id milik user yang ditautkan. site_admin cuma
        // boleh lihat tautan stafnya sendiri, bukan seluruh site lain.
        $links = TelegramUserLink::with('user:id,name,username,organization_id')
            ->when(
                ! $this->hasCrossOrganizationAccess($user),
                fn ($q) => $q->whereHas('user', fn ($uq) => $uq->where('organization_id', $user->organization_id))
            )
            ->latest('id')->get();

        return $this->success('Daftar tautan akun Telegram', $links->map(fn ($link) => [
            'id' => $link->id,
            'telegram_user_id' => $link->telegram_user_id,
            'telegram_username' => $link->telegram_username,
            'user' => [
                'id' => $link->user->id,
                'name' => $link->user->name,
                'username' => $link->user->username,
            ],
        ]));
    }

    public function store(Request $request)
    {
        $request->user()->can('telegram.manage') || abort(403);

        $data = $request->validate([
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'telegram_user_id' => ['required', 'string', 'max:32'],
            'telegram_username' => ['nullable', 'string', 'max:255'],
        ]);

        $targetUser = User::findOrFail($data['user_id']);

        if (! $this->canManageStaffLink($request->user(), $targetUser)) {
            return $this->fail('Anda tidak berwenang menautkan akun staf ini', null, 403);
        }

        $link = TelegramUserLink::updateOrCreate(
            ['telegram_user_id' => $data['telegram_user_id']],
            [
                'user_id' => $data['user_id'],
                'telegram_username' => $data['telegram_username'] ?? null,
                'created_by' => $request->user()->id,
            ]
        );

        return $this->success('Akun Telegram berhasil ditautkan', $link->load('user:id,name,username'), 201);
    }

    public function destroy(Request $request, TelegramUserLink $telegramUserLink)
    {
        $request->user()->can('telegram.manage') || abort(403);

        if (! $this->canManageStaffLink($request->user(), $telegramUserLink->user)) {
            return $this->fail('Anda tidak berwenang menghapus tautan ini', null, 403);
        }

        $telegramUserLink->delete();

        return $this->success('Tautan akun Telegram dihapus');
    }

    /**
     * Dipakai bot Telegram (role telegram_bot_service) untuk mengecek izin
     * SEBENARNYA pengirim pesan, bukan izin akun layanan bot itu sendiri --
     * sama persis prinsipnya dengan web dashboard/APK master yang menegakkan
     * izin per-user yang login, bukan izin "aplikasi". Tanpa ini siapa pun
     * di grup yang terhubung ke bot bisa lock/unlock device cuma karena bot
     * punya izin itu, padahal staf itu sendiri mungkin cuma staff_viewer.
     */
    public function lookup(Request $request)
    {
        // WAJIB dibatasi ke role telegram_bot_service -- route ini cuma
        // butuh auth:sanctum (lihat routes/api.php), bukan permission
        // apa pun, jadi tanpa cek eksplisit di sini SIAPA PUN yang sudah
        // login (termasuk staff_viewer) bisa query role+permission+
        // accessible_organization_ids staf LAIN lintas organisasi --
        // persis kebocoran privilege yang coba ditutup fitur ini sendiri,
        // ditemukan lewat audit keamanan menyeluruh.
        $request->user()->hasRole('telegram_bot_service') || abort(403);

        $telegramUserId = $request->string('telegram_user_id')->toString();

        if ($telegramUserId === '') {
            return $this->fail('telegram_user_id wajib diisi', null, 422);
        }

        $link = TelegramUserLink::where('telegram_user_id', $telegramUserId)->first();

        if (! $link) {
            return $this->fail('Akun Telegram ini belum ditautkan ke akun staf mana pun', null, 404);
        }

        /** @var User $user */
        $user = $link->user;

        if (! $user->is_active) {
            return $this->fail('Akun staf yang ditautkan sedang dinonaktifkan', null, 403);
        }

        return $this->success('Tautan ditemukan', [
            'id' => $user->id,
            'name' => $user->name,
            'username' => $user->username,
            'organization_id' => $user->organization_id,
            'roles' => $user->getRoleNames(),
            'permissions' => $user->getAllPermissions()->pluck('name'),
            'accessible_organization_ids' => $user->siteAccess()->pluck('organizations.id'),
        ]);
    }

    /**
     * SENGAJA tidak pakai authorizedOrganizationId() trait di sini --
     * fungsi itu mengembalikan null baik untuk "ditolak" MAUPUN untuk
     * "diizinkan tapi organization_id target-nya memang null" (kasus nyata:
     * target-nya sendiri super_admin, organization_id-nya null by design).
     * Dua arti berbeda ketemu di satu nilai null -- cek eksplisit di sini
     * supaya tidak salah tolak admin yang menautkan sesama super_admin.
     */
    private function canManageStaffLink(User $requester, User $target): bool
    {
        if ($this->hasCrossOrganizationAccess($requester)) {
            return true;
        }

        return $target->organization_id !== null && $target->organization_id === $requester->organization_id;
    }
}
