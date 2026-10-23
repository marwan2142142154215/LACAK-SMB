<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\Device;
use App\Models\DeviceOtp;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

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

    /** Maksimum tebakan OTP salah per device sebelum diblokir sementara. */
    private const MAX_OTP_ATTEMPTS = 5;

    /** Lama jendela hitungan percobaan OTP (menit); mengikuti masa berlaku OTP. */
    private const OTP_ATTEMPT_WINDOW_MINUTES = 5;

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

        // Batas percobaan per device (selain throttle per-IP di route): OTP
        // cuma 6 digit, jadi tanpa ini ribuan tebakan bisa dilakukan selama
        // OTP berlaku. Setelah batas tercapai, minta OTP baru dari admin.
        $attemptsKey = "device_otp_attempts:{$device->id}";

        if ((int) Cache::get($attemptsKey, 0) >= self::MAX_OTP_ATTEMPTS) {
            return $this->fail('Terlalu banyak percobaan OTP. Minta admin membuat OTP baru.', null, 429);
        }

        $otp = $device->otps()
            ->where('purpose', 'self_unlock')
            ->whereNull('used_at')
            ->latest('id')
            ->first();

        if (! $otp || ! $otp->isValid() || ! $otp->matches($data['code'])) {
            Cache::put($attemptsKey, (int) Cache::get($attemptsKey, 0) + 1, now()->addMinutes(self::OTP_ATTEMPT_WINDOW_MINUTES));

            return $this->fail('Kode OTP salah atau sudah kedaluwarsa', null, 422);
        }

        DB::transaction(function () use ($otp, $device): void {
            $otp->update(['used_at' => now()]);
            $device->update(['status' => 'online']);
        });

        Cache::forget($attemptsKey);

        return $this->success('OTP benar, device dibuka');
    }
}
