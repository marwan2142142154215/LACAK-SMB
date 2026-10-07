# Skema Database — Sistem MDM / Pelacakan Aset & Parental Control

> Status: draft awal, dibuat sebelum PostgreSQL aktif. Semua tabel memakai
> `id` (bigint, PK), `created_at`, `updated_at` wajib (standar perusahaan 4.2).
> Data yang tidak boleh hilang permanen pakai `deleted_at` (soft delete).
> Data penting mencatat `created_by` / `updated_by`.

## Konteks hukum & consent (wajib ada sebelum device bisa di-manage)

Setiap device yang didaftarkan **wajib** terkait ke satu dokumen consent yang
sudah ditandatangani (surat orang tua untuk anak di bawah umur, atau surat
persetujuan staf perusahaan untuk aset/device kerja). Tanpa `consent_document`
aktif, device tidak boleh menerima perintah lock/unlock/lokasi apa pun —
ini ditegakkan di level API (lihat `devices.consent_document_id NOT NULL`).

## Tabel inti

### `organizations` (site/perusahaan/keluarga — multi-tenant)
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| name | varchar | nama site/perusahaan/keluarga |
| type | enum | `company_asset`, `family_parental` |
| unique_site_code | varchar(32) unique | kode unik ditanam ke APK yang didownload untuk site ini |
| is_active | boolean default true | |
| created_by / updated_by | bigint FK users | |
| created_at / updated_at / deleted_at | timestamp | |

### `users` (admin master, staff, orang tua)
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| organization_id | bigint FK organizations, nullable | null untuk super-admin lintas site |
| username | varchar unique | |
| email | varchar unique | |
| password | varchar | hash (bcrypt/argon2) — **tidak pernah plaintext** |
| two_factor_secret | varchar, nullable | encrypted at rest |
| two_factor_confirmed_at | timestamp, nullable | |
| two_factor_recovery_codes | text, nullable | encrypted |
| role | varchar | dikelola via Spatie Laravel Permission, bukan kolom enum bebas |
| is_active | boolean | |
| created_at / updated_at / deleted_at | timestamp | |

Role via Spatie Permission: `super_admin`, `site_admin`, `staff_viewer`,
`parent`.

### `consent_documents`
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| organization_id | bigint FK organizations | |
| subject_name | varchar | nama anak / staf yang di-manage |
| signer_name | varchar | nama penandatangan (orang tua/HRD) |
| signer_role | enum | `parent`, `hr_staff`, `device_owner` |
| document_file_path | varchar | path relatif di DigitalOcean Spaces (bukan URL penuh — standar 6.3) |
| signed_at | date | |
| valid_until | date, nullable | |
| revoked_at | timestamp, nullable | pencabutan consent menonaktifkan device terkait |
| created_by | bigint FK users | |
| created_at / updated_at | timestamp | |

### `devices`
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| organization_id | bigint FK organizations | |
| consent_document_id | bigint FK consent_documents, NOT NULL | lihat catatan hukum di atas |
| device_name | varchar | nama yang ditampilkan di dashboard/radar |
| device_uuid | varchar unique | id unik dari APK saat instal pertama |
| android_version | varchar | contoh "14", "17" |
| app_build_version | varchar | versi APK pelacak yang terpasang |
| site_code_embedded | varchar | kode site yang ditanam di APK — dicocokkan ke `organizations.unique_site_code` |
| status | enum | `online`, `offline`, `locked`, `pending_enrollment` |
| battery_level | smallint, nullable | |
| last_seen_at | timestamp, nullable | |
| enrolled_at | timestamp | |
| is_active | boolean default true | |
| created_by / updated_by | bigint FK users | |
| created_at / updated_at / deleted_at | timestamp | |

Indeks: `device_uuid`, `organization_id`, `consent_document_id`, `status`.

### `device_locations` (riwayat + posisi radar realtime)
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| device_id | bigint FK devices | indeks |
| source | enum | `ble`, `gps`, `ble_estimated` |
| latitude | decimal(10,7), nullable | null kalau sumbernya BLE-only (jarak relatif, bukan koordinat absolut) |
| longitude | decimal(10,7), nullable | |
| ble_distance_meters | decimal(6,2), nullable | estimasi jarak dari anchor master |
| ble_rssi | smallint, nullable | |
| recorded_at | timestamp | waktu device merekam, bukan waktu server terima |
| created_at | timestamp | |

Tabel ini besar & append-only → kandidat partisi per bulan saat datanya
sudah ribuan device (dibahas ulang di Development Checkpoint sesuai aturan
4.4 soal query berat).

### `geofence_rules` (whitelist IP/WiFi)
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| organization_id | bigint FK organizations | |
| rule_name | varchar | |
| allowed_ssid | varchar, nullable | |
| allowed_ip_cidr | varchar, nullable | contoh `192.168.1.0/24` |
| max_distance_meters | integer, nullable | jarak BLE maksimum sebelum auto-lock |
| is_active | boolean | |
| created_by | bigint FK users | |
| created_at / updated_at | timestamp | |

### `violation_logs`
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| device_id | bigint FK devices | |
| geofence_rule_id | bigint FK geofence_rules, nullable | |
| violation_type | enum | `wifi_mismatch`, `ip_mismatch`, `distance_exceeded` |
| detected_value | varchar | SSID/IP/jarak yang terdeteksi |
| notified_telegram | boolean default false | |
| notified_dashboard | boolean default false | |
| detected_at | timestamp | |
| created_at | timestamp | |

### `device_commands` (lock/unlock/ping-radar — audit trail wajib)
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| device_id | bigint FK devices | |
| command_type | enum | `lock`, `unlock`, `start_monitor`, `stop_monitor`, `locate_now` |
| issued_by | bigint FK users | siapa yang klik — wajib (standar 6.4 + activity log) |
| issued_via | enum | `web_dashboard`, `master_app`, `telegram_bot` |
| status | enum | `pending`, `delivered`, `acknowledged`, `failed` |
| reason_note | varchar, nullable | alasan lock (ditampilkan ke device: "Silahkan kembali ke lokasi Anda") |
| acknowledged_at | timestamp, nullable | |
| created_at | timestamp | |

### `device_otps`
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| device_id | bigint FK devices | |
| otp_code_hash | varchar | **di-hash**, bukan plaintext, walau OTP berumur pendek |
| purpose | enum | `self_unlock` |
| expires_at | timestamp | OTP wajib kedaluwarsa (standar 6.4: sesi/token tidak berlaku selamanya) |
| used_at | timestamp, nullable | |
| created_at | timestamp | |

### `apk_builds` (APK per site dengan kode unik tertanam)
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| organization_id | bigint FK organizations | |
| version | varchar | |
| file_path | varchar | path di DigitalOcean Spaces |
| embedded_site_code | varchar | sama dengan `organizations.unique_site_code` saat build |
| checksum_sha256 | varchar | APK pelacak **memverifikasi checksum ini saat start** — kalau ada 2 kode unik sama terdeteksi beda checksum → APK menolak jalan & tampilkan "silahkan download dari sumber resmi bosku" |
| built_by | bigint FK users | |
| created_at | timestamp | |

### `telegram_bindings`
| kolom | tipe | keterangan |
|---|---|---|
| id | bigint PK | |
| organization_id | bigint FK organizations | |
| telegram_chat_id | varchar | |
| bot_token_ref | varchar | **referensi ke secret manager/.env, bukan token asli di DB** |
| is_active | boolean | |
| created_at / updated_at | timestamp | |

### `activity_logs`
Dipakai via **Spatie Activity Log** (standar 1.4) — bukan tabel custom.
Mencatat setiap perubahan `devices`, `device_commands`, `consent_documents`,
`geofence_rules`, login 2FA, dan perubahan role user.

## Prinsip yang ditegakkan skema ini

1. **Tidak ada device tanpa consent** — FK `consent_document_id` NOT NULL.
2. **Tidak ada command tanpa pelaku** — `device_commands.issued_by` NOT NULL,
   jadi setiap lock/unlock bisa dipertanggungjawabkan ke satu akun.
3. **OTP & token selalu punya masa berlaku** — tidak ada kolom tanpa
   `expires_at` untuk kredensial sementara.
4. **Checksum APK mencegah APK bajakan/duplikat kode site** sesuai
   permintaan awal, tanpa fitur anti-uninstall atau kamera tersembunyi.
5. **Lokasi BLE-only tidak dipaksakan jadi koordinat GPS palsu** — kolom
   lat/long nullable, karena BLE hanya memberi estimasi jarak, bukan
   posisi absolut (radar UI menggabungkan BLE relative + GPS absolute).
