<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Responses\ApiResponse;
use App\Models\Device;
use App\Models\DeviceOtp;
use App\Support\ResolvesOrganizationScope;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

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

    /**
     * Buat kode pairing 6 digit (purpose 'pairing', beda dari OTP buka-kunci
     * 'self_unlock') -- admin lihat kode ini di dashboard lalu ketikkan ke
     * APK pelacak di device fisik secara langsung. Ini satu-satunya jalur
     * device_secret sampai ke device: kode cuma berlaku 5 menit dan sekali
     * pakai, jadi device_secret yang dihasilkan dari sini tidak pernah lewat
     * jaringan mana pun selain koneksi HTTPS device itu sendiri ke endpoint
     * pair() di bawah (lihat Vuln 5 di security review -- sebelumnya
     * identitas device cuma device_uuid+siteCode yang tidak rahasia sama
     * sekali, bisa dipalsukan siapa pun yang tahu dua nilai itu).
     */
    public function generatePairingCode(Request $request, Device $device)
    {
        $request->user()->can('devices.manage') || abort(403);

        if ($this->authorizedOrganizationId($request->user(), $device->organization_id) === null) {
            return $this->fail('Anda tidak berwenang memasangkan device ini', null, 403);
        }

        ['otp' => $otp, 'plain_code' => $plainCode] = DeviceOtp::generateFor($device, 'pairing');

        return $this->success('Kode pairing dibuat, berlaku 5 menit. Ketikkan ke APK di device fisik.', [
            'otp_id' => $otp->id,
            'code' => $plainCode,
            'expires_at' => $otp->expires_at,
        ], 201);
    }

    /**
     * Dipanggil langsung oleh APK pelacak saat admin mengetikkan kode
     * pairing di device fisik. TIDAK pakai Sanctum (sama seperti verify() --
     * device belum/tidak sedang login), diamankan lewat device_uuid+kode+
     * rate limit. Men-generate device_secret BARU setiap dipanggil (jadi
     * device lama yang di-pairing ulang otomatis dapat secret baru, yang
     * lama otomatis tidak berlaku lagi).
     */
    public function pair(Request $request)
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
            ->where('purpose', 'pairing')
            ->whereNull('used_at')
            ->latest('id')
            ->first();

        if (! $otp || ! $otp->isValid() || ! $otp->matches($data['code'])) {
            return $this->fail('Kode pairing salah atau sudah kedaluwarsa', null, 422);
        }

        $otp->update(['used_at' => now()]);

        $deviceSecret = Str::random(40);
        $device->device_secret = $deviceSecret;
        $device->save();

        return $this->success('Pairing berhasil', [
            'device_secret' => $deviceSecret,
        ]);
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
