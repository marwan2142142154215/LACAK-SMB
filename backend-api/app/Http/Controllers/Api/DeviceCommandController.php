<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\DeviceCommandResource;
use App\Http\Responses\ApiResponse;
use App\Models\Device;
use App\Models\DeviceCommand;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Perintah ke device (lock/unlock/start_monitor/stop_monitor/locate_now).
 * Setiap perintah WAJIB tercatat siapa yang mengeluarkan (issued_by) — ini
 * jejak audit yang dipakai pertanggungjawaban hukum (surat consent).
 *
 * Pengiriman perintah sebenarnya ke device (lewat realtime gateway AdonisJS)
 * ditambahkan di tahap berikutnya — controller ini hanya mencatat perintah
 * dengan status 'pending'; gateway yang mengubah ke 'delivered'/'acknowledged'.
 */
class DeviceCommandController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function index(Request $request, Device $device)
    {
        $request->user()->can('devices.view') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $device->organization_id) === null) {
            return $this->fail('Anda tidak berwenang melihat riwayat perintah device ini', null, 403);
        }

        $commands = $device->commands()->latest('created_at')->paginate($request->integer('per_page', 20));

        return $this->success('Riwayat perintah', [
            'items' => DeviceCommandResource::collection($commands),
            'total' => $commands->total(),
        ]);
    }

    public function store(Request $request, Device $device)
    {
        $data = $request->validate([
            'command_type' => ['required', Rule::in(['lock', 'unlock', 'start_monitor', 'stop_monitor', 'locate_now'])],
            // 'system_auto' sengaja tidak termasuk di sini — hanya gateway yang
            // menulis baris itu langsung ke DB (tidak lewat endpoint HTTP ini),
            // supaya tidak ada klien luar yang bisa menyamar sebagai sistem.
            'issued_via' => ['required', Rule::in(['web_dashboard', 'master_app', 'telegram_bot'])],
            'reason_note' => ['nullable', 'string', 'max:255'],
        ]);

        $permissionMap = [
            'lock' => 'devices.lock',
            'unlock' => 'devices.unlock',
            'locate_now' => 'devices.locate',
            'start_monitor' => 'devices.monitor',
            'stop_monitor' => 'devices.monitor',
        ];

        $request->user()->can($permissionMap[$data['command_type']]) || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $device->organization_id) === null) {
            return $this->fail('Anda tidak berwenang mengirim perintah ke device ini', null, 403);
        }

        // 'unlock' tetap diizinkan walau consent sudah dicabut/kedaluwarsa,
        // supaya device tidak pernah terkunci permanen tanpa jalan keluar.
        $consent = $device->consentDocument;
        if ($data['command_type'] !== 'unlock' && (! $consent || ! $consent->isActive())) {
            return $this->fail('Dokumen consent device ini sudah tidak berlaku. Hanya perintah unlock yang diizinkan.', null, 422);
        }

        if (! $device->is_active) {
            return $this->fail('Device dinonaktifkan, tidak bisa menerima perintah', null, 422);
        }

        $command = DeviceCommand::create([
            'device_id' => $device->id,
            'command_type' => $data['command_type'],
            'issued_by' => $request->user()->id,
            'issued_via' => $data['issued_via'],
            'status' => 'pending',
            'reason_note' => $data['reason_note'] ?? null,
            'created_at' => now(),
        ]);

        if ($data['command_type'] === 'lock') {
            $device->update(['status' => 'locked', 'updated_by' => $request->user()->id]);
        } elseif ($data['command_type'] === 'unlock') {
            $device->update(['status' => 'online', 'updated_by' => $request->user()->id]);
        }

        return $this->success('Perintah berhasil dikirim, menunggu diterima device', new DeviceCommandResource($command), 201);
    }
}
