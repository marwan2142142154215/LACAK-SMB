<?php

namespace App\Support;

use App\Models\TelegramBinding;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;

/**
 * Aturan scoping multi-tenant:
 *  - super_admin: lintas site penuh (tidak dibatasi).
 *  - telegram_bot_service: terkunci ke site milik chat Telegram yang sedang
 *    dilayani -- bot wajib mengirim header X-Telegram-Chat-Id, lalu site-nya
 *    di-resolve DI SINI dari telegram_bindings (aktif). Tanpa header / chat
 *    tidak terikat = tidak ada akses.
 *  - admin / leader: dibatasi ke site yang DIBERIKAN IZIN eksplisit oleh
 *    super_admin lewat tabel user_site_access (bisa lebih dari satu site,
 *    beda dari organization_id "rumah" yang cuma satu) -- role ini VIEW-ONLY
 *    (lihat RolesAndPermissionsSeeder, tidak ada *.manage), jadi method di
 *    sini dipakai controller index/show, bukan untuk endpoint tulis.
 *  - role lain (site_admin, staff_viewer, dst): terkunci ke organization_id
 *    miliknya sendiri saja.
 *
 * Satu bot token melayani banyak chat Telegram yang masing-masing terikat
 * ke organization berbeda. Pencocokan chat -> site SENGAJA ditegakkan di
 * server, bukan dipercayakan ke bot: sebelumnya bot meneruskan ID device
 * ketikan user apa adanya, sehingga anggota grup site A bisa lock/unlock
 * device site B.
 */
trait ResolvesOrganizationScope
{
    private function hasCrossOrganizationAccess(User $user): bool
    {
        return $user->hasRole('super_admin');
    }

    private function isTelegramBotService(User $user): bool
    {
        return $user->hasRole('telegram_bot_service');
    }

    /** Site milik chat Telegram yang sedang dilayani bot (header X-Telegram-Chat-Id), atau null. */
    private function telegramChatOrganizationId(): ?int
    {
        $chatId = (string) request()->header('X-Telegram-Chat-Id', '');

        if ($chatId === '') {
            return null;
        }

        $organizationId = TelegramBinding::where('telegram_chat_id', $chatId)
            ->where('is_active', true)
            ->value('organization_id');

        return $organizationId !== null ? (int) $organizationId : null;
    }

    private function hasGrantBasedAccess(User $user): bool
    {
        return $user->hasRole('admin') || $user->hasRole('leader');
    }

    /** Daftar organization_id yang boleh diakses user grant-based, dari cache relasi kalau sudah di-load. */
    private function grantedOrganizationIds(User $user): array
    {
        return $user->relationLoaded('siteAccess')
            ? $user->siteAccess->pluck('id')->all()
            : $user->siteAccess()->pluck('organizations.id')->all();
    }

    /**
     * Pastikan user boleh beroperasi di organization_id yang diminta.
     * Return organization_id yang dipakai, atau null jika ditolak (panggil
     * method ini lalu cek null di controller untuk balas 403).
     */
    protected function authorizedOrganizationId(User $user, ?int $requestedOrganizationId): ?int
    {
        if ($this->hasCrossOrganizationAccess($user)) {
            return $requestedOrganizationId;
        }

        if ($this->isTelegramBotService($user)) {
            $chatOrganizationId = $this->telegramChatOrganizationId();

            if ($chatOrganizationId === null) {
                return null;
            }

            return ($requestedOrganizationId === null || $requestedOrganizationId === $chatOrganizationId)
                ? $chatOrganizationId
                : null;
        }

        if ($this->hasGrantBasedAccess($user)) {
            if ($requestedOrganizationId === null) {
                return null; // admin/leader wajib sebutkan site mana, tidak ada "default milik sendiri".
            }

            return in_array($requestedOrganizationId, $this->grantedOrganizationIds($user), true)
                ? $requestedOrganizationId
                : null;
        }

        if ($requestedOrganizationId !== null && $requestedOrganizationId !== $user->organization_id) {
            return null;
        }

        return $user->organization_id;
    }

    /**
     * Terapkan filter organization_id ke query sesuai scope user.
     *
     * Mengembalikan null (bukan query diam-diam dibatasi ke org sendiri) saat
     * non-super_admin secara eksplisit meminta organization_id milik orang
     * lain — supaya controller membalas 403 yang jelas, bukan diam-diam
     * menukar ke data org miliknya sendiri (membingungkan & menyembunyikan
     * percobaan akses tidak sah).
     */
    protected function scopeToOrganization(Builder $query, User $user, ?int $requestedOrganizationId = null): ?Builder
    {
        if ($this->hasCrossOrganizationAccess($user)) {
            return $requestedOrganizationId ? $query->where('organization_id', $requestedOrganizationId) : $query;
        }

        if ($this->isTelegramBotService($user)) {
            $chatOrganizationId = $this->authorizedOrganizationId($user, $requestedOrganizationId);

            return $chatOrganizationId !== null ? $query->where('organization_id', $chatOrganizationId) : null;
        }

        if ($this->hasGrantBasedAccess($user)) {
            $granted = $this->grantedOrganizationIds($user);

            if ($requestedOrganizationId !== null) {
                return in_array($requestedOrganizationId, $granted, true)
                    ? $query->where('organization_id', $requestedOrganizationId)
                    : null;
            }

            return $query->whereIn('organization_id', $granted);
        }

        if ($requestedOrganizationId !== null && $requestedOrganizationId !== $user->organization_id) {
            return null;
        }

        return $query->where('organization_id', $user->organization_id);
    }
}
