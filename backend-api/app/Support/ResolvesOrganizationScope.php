<?php

namespace App\Support;

use App\Models\User;
use Illuminate\Database\Eloquent\Builder;

/**
 * Aturan scoping multi-tenant: super_admin bisa lintas site, role lain
 * (site_admin, parent, staff_viewer) terkunci ke organization_id miliknya
 * sendiri. Dipakai di semua controller yang berhubungan dengan satu site.
 */
trait ResolvesOrganizationScope
{
    /**
     * Pastikan user boleh beroperasi di organization_id yang diminta.
     * Return organization_id yang dipakai, atau null jika ditolak (panggil
     * method ini lalu cek null di controller untuk balas 403).
     */
    protected function authorizedOrganizationId(User $user, ?int $requestedOrganizationId): ?int
    {
        if ($user->hasRole('super_admin')) {
            return $requestedOrganizationId;
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
        if ($user->hasRole('super_admin')) {
            return $requestedOrganizationId ? $query->where('organization_id', $requestedOrganizationId) : $query;
        }

        if ($requestedOrganizationId !== null && $requestedOrganizationId !== $user->organization_id) {
            return null;
        }

        return $query->where('organization_id', $user->organization_id);
    }
}
