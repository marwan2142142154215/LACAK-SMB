<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreUserRequest;
use App\Http\Requests\UpdateUserRequest;
use App\Http\Resources\UserResource;
use App\Http\Responses\ApiResponse;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;

/**
 * Kelola staf yang bisa login ke web dashboard & APK master (permission
 * users.manage -- hari ini cuma dipegang super_admin, lihat
 * RolesAndPermissionsSeeder). Bot Telegram TIDAK ikut di sini: satu chat
 * terikat ke satu site lewat telegram_bindings (TelegramBindingController),
 * bukan login per-staf -- staf yang dibuat di sini otomatis bisa dipakai di
 * site mana pun yang chat Telegram site itu sudah ditautkan, tidak perlu
 * langkah tambahan.
 */
class UserController extends Controller
{
    use ApiResponse;

    public function index(Request $request)
    {
        $request->user()->can('users.manage') || abort(403);

        $users = User::with(['roles', 'siteAccess'])
            ->when($request->integer('organization_id'), fn ($q, $orgId) => $q->where('organization_id', $orgId))
            ->orderBy('name')
            ->paginate($request->integer('per_page', 20));

        return $this->success('Daftar staf', [
            'items' => UserResource::collection($users),
            'total' => $users->total(),
        ]);
    }

    public function store(StoreUserRequest $request)
    {
        $user = User::create([
            'name' => $request->validated('name'),
            'username' => $request->validated('username'),
            'email' => $request->validated('email'),
            'password' => Hash::make($request->validated('password')),
            'organization_id' => $request->validated('organization_id'),
            'is_active' => true,
            // Akun staf langsung aktif tanpa paksaan setup 2FA di login pertama
            // sengaja TIDAK dilakukan di sini -- login pertama tetap memicu
            // enrollment 2FA lewat AuthController, sama seperti akun lain.
        ]);

        $user->assignRole($request->validated('role'));

        if ($request->validated('site_access')) {
            $user->siteAccess()->sync(
                collect($request->validated('site_access'))->mapWithKeys(
                    fn ($orgId) => [$orgId => ['granted_by' => $request->user()->id]]
                )
            );
        }

        return $this->success('Staf berhasil dibuat', new UserResource($user->load(['roles', 'siteAccess'])), 201);
    }

    public function show(Request $request, User $user)
    {
        $request->user()->can('users.manage') || abort(403);

        return $this->success('Detail staf', new UserResource($user->load(['roles', 'siteAccess'])));
    }

    public function update(UpdateUserRequest $request, User $user)
    {
        $user->update(array_filter([
            'name' => $request->validated('name'),
            'email' => $request->validated('email'),
            'organization_id' => $request->validated('organization_id'),
            'password' => $request->filled('password') ? Hash::make($request->validated('password')) : null,
        ], fn ($v) => $v !== null));

        if ($request->filled('role')) {
            $user->syncRoles([$request->validated('role')]);
        }

        return $this->success('Staf berhasil diperbarui', new UserResource($user->fresh(['roles', 'siteAccess'])));
    }

    public function destroy(Request $request, User $user)
    {
        $request->user()->can('users.manage') || abort(403);

        if ($user->id === $request->user()->id) {
            return $this->fail('Tidak bisa menghapus akun sendiri', null, 422);
        }

        $user->delete();

        return $this->success('Staf berhasil dihapus');
    }

    public function suspend(Request $request, User $user)
    {
        $request->user()->can('users.manage') || abort(403);

        if ($user->id === $request->user()->id) {
            return $this->fail('Tidak bisa men-suspend akun sendiri', null, 422);
        }

        $user->update(['is_active' => false]);
        $user->tokens()->delete();

        return $this->success('Staf disuspen — semua sesi login dicabut', new UserResource($user->fresh(['roles', 'siteAccess'])));
    }

    public function reactivate(Request $request, User $user)
    {
        $request->user()->can('users.manage') || abort(403);

        $user->update(['is_active' => true]);

        return $this->success('Staf diaktifkan kembali', new UserResource($user->fresh(['roles', 'siteAccess'])));
    }

    /**
     * Reset 2FA staf (HP authenticator-nya hilang/ganti) -- mengosongkan
     * secret & recovery codes supaya login berikutnya otomatis memicu setup
     * 2FA dari awal lagi (QR code baru), sama seperti akun yang belum pernah
     * setup 2FA sama sekali. Sesi login yang sedang aktif ikut dicabut
     * (token dihapus) supaya device lama tidak bisa dipakai lagi tanpa
     * setup ulang -- konsisten dengan suspend().
     */
    public function reset2fa(Request $request, User $user)
    {
        $request->user()->can('users.manage') || abort(403);

        // SENGAJA set properti langsung + save(), BUKAN update() mass-assignment
        // -- ketiga kolom 2FA ini memang tidak termasuk #[Fillable(...)] User
        // (benar secara keamanan: tidak boleh bisa ditimpa lewat mass-assignment
        // biasa), jadi update(['two_factor_secret' => null, ...]) diam-diam
        // tidak melakukan apa-apa untuk kolom itu tanpa error apa pun. Assignment
        // properti langsung selalu diizinkan terlepas dari $fillable/#[Fillable].
        $user->two_factor_secret = null;
        $user->two_factor_recovery_codes = null;
        $user->two_factor_confirmed_at = null;
        $user->save();
        $user->tokens()->delete();

        return $this->success("2FA {$user->name} direset — login berikutnya akan diminta setup ulang", new UserResource($user->fresh(['roles', 'siteAccess'])));
    }

    /** Atur site mana saja yang boleh dilihat user dengan role admin/leader. */
    public function syncSiteAccess(Request $request, User $user)
    {
        $request->user()->can('users.manage') || abort(403);

        $data = $request->validate([
            'organization_ids' => ['required', 'array'],
            'organization_ids.*' => ['integer', 'exists:organizations,id'],
        ]);

        $user->siteAccess()->sync(
            collect($data['organization_ids'])->mapWithKeys(
                fn ($orgId) => [$orgId => ['granted_by' => $request->user()->id]]
            )
        );

        return $this->success('Akses site diperbarui', new UserResource($user->fresh(['roles', 'siteAccess'])));
    }
}
