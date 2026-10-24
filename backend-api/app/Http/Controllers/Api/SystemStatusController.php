<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Services\ServerStatus;
use Illuminate\Http\Request;

/**
 * Status semua layanan server (menu Akses > Status server) -- hanya
 * pemegang permission security.manage (super_admin): isinya detail
 * infrastruktur yang tidak perlu dilihat peran lain.
 */
class SystemStatusController extends Controller
{
    use ApiResponse;

    public function __invoke(Request $request, ServerStatus $status)
    {
        $request->user()->can('security.manage') || abort(403);

        return $this->success('Status server', $status->snapshot());
    }
}
