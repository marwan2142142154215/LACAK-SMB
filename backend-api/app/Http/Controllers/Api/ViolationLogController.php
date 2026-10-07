<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\ViolationLogResource;
use App\Http\Responses\ApiResponse;
use App\Models\Device;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;

/**
 * Read-only dari sisi API ini. Pencatatan violation_logs yang sebenarnya
 * (deteksi WiFi/IP di luar whitelist) dibuat oleh realtime gateway AdonisJS
 * saat device melapor, lalu gateway yang memicu notifikasi Telegram/dashboard.
 */
class ViolationLogController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function index(Request $request, Device $device)
    {
        $request->user()->can('devices.view') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $device->organization_id) === null) {
            return $this->fail('Anda tidak berwenang melihat log pelanggaran device ini', null, 403);
        }

        $logs = $device->violationLogs()->latest('detected_at')->paginate($request->integer('per_page', 20));

        return $this->success('Log pelanggaran geofence', [
            'items' => ViolationLogResource::collection($logs),
            'total' => $logs->total(),
        ]);
    }
}
