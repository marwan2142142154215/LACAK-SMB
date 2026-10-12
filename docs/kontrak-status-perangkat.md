# Kontrak data: status perangkat (screen on time & detail)

Sumber kebenaran bersama untuk android-tracked-app, realtime-gateway, backend-api, dan web-dashboard.

## 1. Event socket `device:status_report` (aplikasi pelacak -> gateway, namespace `/device`)

Dikirim setiap 5 menit dan sesaat setelah `device:accepted`. Hanya diterima dari socket yang sudah lolos autentikasi secret device; `device_id` diambil dari socket, BUKAN dari payload.

```json
{
    "recordedAt": "2026-10-12T08:15:00+07:00",
    "battery": {
        "level": 82,
        "isCharging": true,
        "chargerType": "usb",
        "temperatureCelsius": 31.5,
        "health": "good"
    },
    "network": {
        "type": "wifi",
        "wifiSsid": "SMB-Office",
        "signalLevel": 3,
        "carrierName": "Telkomsel",
        "isAirplaneMode": false,
        "isGpsEnabled": true
    },
    "device": {
        "brand": "samsung",
        "model": "SM-A155F",
        "androidVersion": "14",
        "appVersion": "1.0.0",
        "storageFreeBytes": 21474836480,
        "storageTotalBytes": 64424509440,
        "ramFreeBytes": 1610612736,
        "ramTotalBytes": 4294967296,
        "uptimeSeconds": 86400
    },
    "screen": {
        "isScreenOn": true,
        "lastOnAt": "2026-10-12T08:10:00+07:00",
        "lastOffAt": "2026-10-12T08:05:00+07:00"
    },
    "isUsageAccessGranted": true,
    "screenTimeDaily": [
        { "date": "2026-10-12", "screenOnSeconds": 5400, "screenOnCount": 37 }
    ],
    "appUsageDaily": [
        {
            "date": "2026-10-12",
            "packageName": "com.whatsapp",
            "appLabel": "WhatsApp",
            "foregroundSeconds": 1800,
            "lastUsedAt": "2026-10-12T08:09:00+07:00"
        }
    ]
}
```

Aturan:
- `chargerType`: `ac` | `usb` | `wireless` | `null`. `health`: `good` | `overheat` | `dead` | `over_voltage` | `cold` | `unknown`.
- `network.type`: `wifi` | `cellular` | `ethernet` | `none`. `signalLevel`: 0-4 atau `null`.
- `screenTimeDaily` dan `appUsageDaily` berisi hari ini dan kemarin (tanggal lokal HP, `YYYY-MM-DD`). Nilainya **total kumulatif hari itu** (bukan selisih) -> gateway melakukan upsert/timpa.
- `appUsageDaily` = `[]` bila `isUsageAccessGranted` false. Aplikasi dengan `foregroundSeconds` 0 tidak dikirim.
- Field yang tidak bisa dibaca dikirim `null`, tidak dihilangkan.

## 2. Tabel (migration di backend-api; gateway hanya menulis)

`device_status_snapshots` — satu baris per laporan
- `id`, `device_id` (FK devices, index), `recorded_at` (timestampTz)
- `battery_level` (smallint null), `is_charging` (bool null), `charger_type` (string null), `battery_temperature_celsius` (decimal 4,1 null), `battery_health` (string null)
- `network_type` (string null), `wifi_ssid` (string null), `signal_level` (smallint null), `carrier_name` (string null), `is_airplane_mode` (bool null), `is_gps_enabled` (bool null)
- `device_brand`, `device_model`, `android_version`, `app_version` (string null)
- `storage_free_bytes`, `storage_total_bytes`, `ram_free_bytes`, `ram_total_bytes`, `uptime_seconds` (bigint null)
- `is_screen_on` (bool null), `screen_last_on_at`, `screen_last_off_at` (timestampTz null)
- `is_usage_access_granted` (bool, default false)
- `created_at`, `updated_at`
- index (`device_id`, `recorded_at`)

`device_screen_time_daily`
- `id`, `device_id` (FK, index), `usage_date` (date), `screen_on_seconds` (int), `screen_on_count` (int), `created_at`, `updated_at`
- unique (`device_id`, `usage_date`)

`device_app_usage_daily`
- `id`, `device_id` (FK, index), `usage_date` (date), `package_name` (string), `app_label` (string null), `foreground_seconds` (int), `last_used_at` (timestampTz null), `created_at`, `updated_at`
- unique (`device_id`, `usage_date`, `package_name`)

Semua FK `cascadeOnDelete` (ikut terhapus bersama device, sama seperti device_locations).

## 3. API backend (semua di `/api/v1`, `auth:sanctum`, scope organisasi seperti DeviceController::show)

- `GET /devices/{device}/status` -> `data`: snapshot terbaru (snake_case, sama dengan kolom tabel kecuali `device_id`) atau `null`.
- `GET /devices/{device}/screen-time?from=YYYY-MM-DD&to=YYYY-MM-DD` -> `data.items`: `[{ usage_date, screen_on_seconds, screen_on_count }]` urut tanggal naik. Default 7 hari terakhir, maksimal 31 hari.
- `GET /devices/{device}/app-usage?date=YYYY-MM-DD&page=1&per_page=20` -> `data.items`: `[{ package_name, app_label, foreground_seconds, last_used_at }]` urut `foreground_seconds` turun, plus `data.total`. Default tanggal hari ini.

Semua respons memakai bentuk standar `{ success, message, data }`.
