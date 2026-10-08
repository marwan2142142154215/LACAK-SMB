<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * organizations.type dan consent_documents.signer_role sebelumnya native
 * Postgres enum (CHECK constraint) berisi istilah "family_parental" /
 * "parent" / "hr_staff" / "device_owner" -- dihapus sesuai keputusan produk
 * (sistem murni MDM/aset perusahaan, bukan parental control). Diubah ke
 * varchar polos + validasi di level aplikasi (FormRequest) supaya daftar
 * peran bisa diubah lagi nanti tanpa migrasi DB berulang.
 */
return new class extends Migration
{
    public function up(): void
    {
        // CHECK constraint-nya harus dicabut DULU -- selama masih ada, baris
        // tidak bisa diupdate ke nilai peran baru yang belum "dikenal" enum lama.
        DB::statement('ALTER TABLE consent_documents DROP CONSTRAINT IF EXISTS consent_documents_signer_role_check');
        DB::statement('ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_type_check');

        DB::statement('ALTER TABLE organizations ALTER COLUMN type TYPE VARCHAR(20) USING type::text');
        DB::statement('ALTER TABLE consent_documents ALTER COLUMN signer_role TYPE VARCHAR(20) USING signer_role::text');

        // Data lama: satu-satunya nilai signer_role yang pernah dipakai
        // adalah 'device_owner' -- dipetakan ke 'manager' (peran baru yang
        // paling dekat maknanya) supaya tidak ada baris yang nyangkut di
        // nilai yang sudah tidak valid lagi.
        DB::table('consent_documents')->where('signer_role', 'device_owner')->update(['signer_role' => 'manager']);
        DB::table('consent_documents')->where('signer_role', 'parent')->update(['signer_role' => 'manager']);
        DB::table('consent_documents')->where('signer_role', 'hr_staff')->update(['signer_role' => 'hrd']);
        DB::table('organizations')->where('type', 'family_parental')->update(['type' => 'company_asset']);
    }

    public function down(): void
    {
        // Enum lama sudah tidak ada setelah up() jalan -- down() di sini
        // sengaja no-op (tidak ada jalan aman mengembalikan ke enum lama
        // yang istilahnya sudah dihapus dari produk).
    }
};
