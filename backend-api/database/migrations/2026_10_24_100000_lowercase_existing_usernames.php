<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Username sekarang selalu huruf kecil (lihat User::username()). Akun
     * lama yang terlanjur memakai huruf besar ikut dikecilkan -- kecuali kalau
     * versi huruf kecilnya sudah dipakai akun lain, yang itu dibiarkan supaya
     * tidak bentrok; login tetap jalan karena pencocokan tidak peka huruf.
     */
    public function up(): void
    {
        DB::statement(<<<'SQL'
            UPDATE users SET username = LOWER(username)
            WHERE username <> LOWER(username)
              AND NOT EXISTS (
                  SELECT 1 FROM users AS other
                  WHERE other.username = LOWER(users.username) AND other.id <> users.id
              )
            SQL);
    }

    /**
     * Huruf besar aslinya tidak disimpan, jadi tidak bisa dikembalikan.
     */
    public function down(): void
    {
        //
    }
};
