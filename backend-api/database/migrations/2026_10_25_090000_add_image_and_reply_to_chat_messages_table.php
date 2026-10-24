<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Chat staf: lampiran gambar & balas pesan. Pesan boleh berupa gambar saja,
 * jadi body jadi nullable. Gambar disimpan di documents_disk (privat) dan
 * hanya bisa dibuka lewat tautan bertanda tangan.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('chat_messages', function (Blueprint $table) {
            $table->text('body')->nullable()->change();
            $table->foreignId('reply_to_id')->nullable()->after('user_id')->constrained('chat_messages')->nullOnDelete();
            $table->string('image_path')->nullable()->after('body');
            $table->string('image_mime', 50)->nullable()->after('image_path');
            $table->unsignedInteger('image_width')->nullable()->after('image_mime');
            $table->unsignedInteger('image_height')->nullable()->after('image_width');
        });
    }

    public function down(): void
    {
        Schema::table('chat_messages', function (Blueprint $table) {
            $table->dropConstrainedForeignId('reply_to_id');
            $table->dropColumn(['image_path', 'image_mime', 'image_width', 'image_height']);
        });
    }
};
