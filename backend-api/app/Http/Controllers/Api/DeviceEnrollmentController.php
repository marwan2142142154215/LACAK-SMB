<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\Device;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Penerbitan rahasia device untuk autentikasi ke realtime-gateway.
 *
 * Admin mendaftarkan device (DeviceController::store) memakai device_uuid
 * yang tampil di layar APK pelacak — nilai itu TIDAK rahasia. APK lalu
 * "mengklaim" pendaftarannya lewat claim(): server membuat token acak,
 * menyimpan hash-nya saja, dan mengembalikan token asli SEKALI. Klaim hanya
 * diterima selama device masih pending_enrollment dan belum punya rahasia,
 * jadi device yang sudah aktif tidak bisa diambil alih hanya dengan tahu
 * device_uuid-nya. reEnroll() membuka jendela klaim lagi (rahasia lama
 * langsung tidak berlaku) untuk device lama atau device yang rahasianya hilang.
 */
class DeviceEnrollmentController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    /** 32 byte acak = 256 bit; cukup tinggi entropinya sehingga SHA-256 tanpa salt aman dipakai. */
    private const SECRET_BYTES = 32;

    public function claim(Request $request): JsonResponse
    {
        $data = $request->validate([
            'device_uuid' => ['required', 'string', 'max:255'],
        ]);

        $plainSecret = bin2hex(random_bytes(self::SECRET_BYTES));

        // lockForUpdate di dalam transaksi supaya dua klaim bersamaan untuk
        // device yang sama tidak sama-sama lolos dan saling menimpa rahasia.
        $isClaimed = DB::transaction(function () use ($data, $plainSecret): bool {
            $device = Device::where('device_uuid', $data['device_uuid'])
                ->where('is_active', true)
                ->where('status', 'pending_enrollment')
                ->whereNull('secret_hash')
                ->lockForUpdate()
                ->first();

            if (! $device) {
                return false;
            }

            $device->forceFill(['secret_hash' => hash('sha256', $plainSecret)])->save();

            return true;
        });

        // Pesan sengaja sama untuk "belum didaftarkan" dan "sudah diklaim"
        // supaya endpoint publik ini tidak bisa dipakai menebak status device.
        if (! $isClaimed) {
            return $this->fail('Device belum didaftarkan admin atau perlu didaftarkan ulang. Hubungi admin site.', null, 404);
        }

        return $this->success('Device berhasil diaktifkan', [
            'device_secret' => $plainSecret,
        ]);
    }

    public function reEnroll(Request $request, Device $device): JsonResponse
    {
        $request->user()->can('devices.manage') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $device->organization_id) === null) {
            return $this->fail('Anda tidak berwenang mendaftarkan ulang device ini', null, 403);
        }

        // Status 'locked' akan hilang kalau device diubah ke pending_enrollment
        // (gateway hanya mempertahankan 'locked' yang sudah tercatat), padahal
        // HP-nya masih terkunci — dashboard jadi menampilkan status yang salah.
        if ($device->status === 'locked') {
            return $this->fail('Device sedang terkunci. Buka kunci device terlebih dahulu, lalu daftarkan ulang.', null, 422);
        }

        $device->forceFill([
            'secret_hash' => null,
            'status' => 'pending_enrollment',
            'updated_by' => $request->user()->id,
        ])->save();

        return $this->success('Device siap didaftarkan ulang. Buka aplikasi pelacak di device tersebut agar terhubung kembali.');
    }
}
