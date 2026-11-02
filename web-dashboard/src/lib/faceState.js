/**
 * Keputusan "wajah hilang" dari hasil cek wajah per detik (lihat faceWatch.js), dipisah supaya
 * mudah diuji. Aturannya:
 * - wajah terlihat -> tidak hilang;
 * - tidak ada wajah selama >= missingAfterMs -> hilang;
 * - kamera mati -> bukan urusan wajah (tidak hilang);
 * - cek GAGAL (frame macet, model error) terus-menerus selama >= unknownAfterMs -> status tidak
 *   diketahui, jadi "hilang" dicabut. Error tidak boleh membuat staf tercatat hilang -- dulu status
 *   hilang terakhir tertahan selamanya ("Belum terlihat") walau wajahnya sudah kembali.
 */
export function createFaceState({ missingAfterMs, unknownAfterMs, now = () => Date.now() }) {
    let lastSeen = now()
    let lastChecked = now()
    let missing = false

    return {
        get missing() {
            return missing
        },
        reset() {
            lastSeen = now()
            lastChecked = now()
            missing = false
        },
        cameraOff() {
            lastSeen = now()
            lastChecked = now()
            missing = false
            return missing
        },
        seen() {
            lastSeen = now()
            lastChecked = now()
            missing = false
            return missing
        },
        notSeen() {
            lastChecked = now()
            if (now() - lastSeen >= missingAfterMs) missing = true
            return missing
        },
        failed() {
            if (now() - lastChecked >= unknownAfterMs) {
                // Hitungan "tidak ada wajah" dimulai lagi dari nol setelah cek berhasil berikutnya.
                lastSeen = now()
                missing = false
            }
            return missing
        },
    }
}
