<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\ApkBuild;
use App\Models\Device;
use App\Models\Organization;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;

/**
 * Ringkasan angka lintas site -- untuk super_admin ini benar-benar lintas
 * SEMUA site ("jumlah APK di semua site, jumlah perangkat yang ada, dan
 * lain-lain"); untuk admin/leader otomatis dibatasi ke site yang diberikan
 * izin (lihat ResolvesOrganizationScope), untuk role lain ke organization_id
 * miliknya sendiri. Satu endpoint, scoping-nya konsisten dengan endpoint lain.
 */
class DashboardSummaryController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function show(Request $request)
    {
        $user = $request->user();

        $deviceQuery = $this->scopeToOrganization(Device::query(), $user);
        $apkQuery = $this->scopeToOrganization(ApkBuild::query(), $user);

        if ($deviceQuery === null || $apkQuery === null) {
            return $this->fail('Tidak ada site yang bisa diakses', null, 403);
        }

        // Organization TIDAK punya kolom organization_id (dia sendiri "site"-nya)
        // -- scopeToOrganization tidak bisa dipakai langsung di sini seperti
        // Device/ApkBuild, filter id-nya manual sesuai jenis scope user.
        $orgQuery = Organization::query();
        if (! $user->hasRole('super_admin') && ! $user->hasRole('telegram_bot_service')) {
            $orgQuery = ($user->hasRole('admin') || $user->hasRole('leader'))
                ? $orgQuery->whereIn('id', $user->siteAccess()->pluck('organizations.id'))
                : $orgQuery->where('id', $user->organization_id);
        }

        return $this->success('Ringkasan dashboard', [
            'organizations_count' => (clone $orgQuery)->count(),
            'devices_count' => (clone $deviceQuery)->count(),
            'devices_by_status' => (clone $deviceQuery)
                ->selectRaw('status, count(*) as total')
                ->groupBy('status')
                ->pluck('total', 'status'),
            'apk_builds_count' => (clone $apkQuery)->count(),
            'apk_builds_by_type' => (clone $apkQuery)
                ->selectRaw('apk_type, count(*) as total')
                ->groupBy('apk_type')
                ->pluck('total', 'apk_type'),
            'apk_builds_success_count' => (clone $apkQuery)->where('status', 'success')->count(),
        ]);
    }
}
