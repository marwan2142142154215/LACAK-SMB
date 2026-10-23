<?php

namespace App\Services;

/**
 * AES-256-CBC yang sepadan dengan App\Library\AesCbc256 milik Account Center
 * (dan AesCbc256.ts di proyek scatter). Bentuknya memang tidak lazim --
 * kunci = md5 heksadesimal dipakai sebagai teks, IV = 16 karakter heksadesimal
 * sebagai teks, hasil = base64 GANDA -- tapi harus persis begini, kalau tidak
 * Account Center menolak tanda tangannya. Dijaga test vektor di
 * AccountCenterLoginTest.
 */
class AesCbc256
{
    private const CIPHER = 'aes-256-cbc';

    public static function keyFrom(string $secret): string
    {
        return md5($secret);
    }

    public static function generateIv(): string
    {
        return substr(md5(random_bytes(32)), 0, 16);
    }

    public static function encrypt(string $plain, string $key, string $iv): string
    {
        // options 0 -> openssl sudah mengembalikan base64; dibungkus base64
        // sekali lagi supaya sama dengan pustaka Account Center.
        return base64_encode(openssl_encrypt($plain, self::CIPHER, $key, 0, $iv));
    }

    public static function decrypt(string $encoded, string $key, string $iv): string|false
    {
        return openssl_decrypt(base64_decode($encoded), self::CIPHER, $key, 0, $iv);
    }
}
