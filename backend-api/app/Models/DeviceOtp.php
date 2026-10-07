<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Hash;

class DeviceOtp extends Model
{
    use HasFactory;

    public $timestamps = false;

    protected $fillable = [
        'device_id',
        'otp_code_hash',
        'purpose',
        'expires_at',
        'used_at',
    ];

    protected $hidden = [
        'otp_code_hash',
    ];

    protected $casts = [
        'expires_at' => 'datetime',
        'used_at' => 'datetime',
        'created_at' => 'datetime',
    ];

    public function device(): BelongsTo
    {
        return $this->belongsTo(Device::class);
    }

    /**
     * Generate a fresh 6-digit OTP for a device, hashed at rest, valid for 5 minutes.
     * Returns the plaintext code (shown once to the operator/device) alongside the record.
     *
     * @return array{otp: self, plain_code: string}
     */
    public static function generateFor(Device $device, string $purpose = 'self_unlock', int $validMinutes = 5): array
    {
        $plainCode = (string) random_int(100000, 999999);

        $otp = self::create([
            'device_id' => $device->id,
            'otp_code_hash' => Hash::make($plainCode),
            'purpose' => $purpose,
            'expires_at' => now()->addMinutes($validMinutes),
        ]);

        return ['otp' => $otp, 'plain_code' => $plainCode];
    }

    public function isValid(): bool
    {
        return $this->used_at === null && $this->expires_at->isFuture();
    }

    public function matches(string $plainCode): bool
    {
        return Hash::check($plainCode, $this->otp_code_hash);
    }
}
