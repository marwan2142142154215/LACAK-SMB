<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\Device;
use App\Models\DeviceOtp;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;

/**
 * OTP per-device untuk buka mandiri saat HP kena mode lock. Generate OTP
 * butuh login admin (operator), tapi verifikasi OTP dipanggil langsung oleh
 * APK pelacak di device target yang sedang terkunci — makanya endpoint
 * verify TIDAK pakai Sanctum (device tidak bisa login saat terkunci),
 * cukup diamankan lewat device_uuid + kode OTP + rate limit (lihat routes/api.php).
 */
class DeviceOtpController extends Controller
{
    use ApiResponse, ResolvesOrganizationScope;

    public function generate(Request $request, Device $device)
    {
        $request->user()->can('devices.unlock') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $device->organization_id) === null) {
            return $this->fail('Anda tidak berwenang membuat OTP untuk device ini', null, 403);
        }

        ['otp' => $otp, 'plain_code' => $plainCode] = DeviceOtp::generateFor($device);

        return $this->success('OTP berhasil dibuat, berlaku 5 menit', [
            'otp_id' => $otp->id,
            'code' => $plainCode,
            'expires_at' => $otp->expires_at,
        ], 201);
    }

    public function verify(Request $request)
    {
        $data = $request->validate([
            'device_uuid' => ['required', 'string'],
            'code' => ['required', 'digits:6'],
        ]);

        $device = Device::where('device_uuid', $data['device_uuid'])->first();

        if (! $device) {
            return $this->fail('Device tidak dikenali', null, 404);
        }

        $otp = $device->otps()
            ->where('purpose', 'self_unlock')
            ->whereNull('used_at')
            ->latest('id')
            ->first();

        if (! $otp || ! $otp->isValid() || ! $otp->matches($data['code'])) {
            return $this->fail('Kode OTP salah atau sudah kedaluwarsa', null, 422);
        }

        $otp->update(['used_at' => now()]);
        $device->update(['status' => 'online']);

        return $this->success('OTP benar, device dibuka');
    }
}
