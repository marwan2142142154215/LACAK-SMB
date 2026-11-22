/**
 * Keputusan "wajah hilang" dari hasil cek wajah per detik (lihat faceWatch.js), dipisah supaya
 * mudah diuji. Aturannya:
 * - wajah terlihat -> tidak hilang;
 * - tidak ada wajah selama >= missingAfterMs DAN minimal minMisses cek berturut-turut -> hilang;
 * - kamera mati / istirahat -> bukan urusan wajah (tidak hilang, hitungan mulai dari nol);
 * - cek GAGAL (frame macet, model error) terus-menerus selama >= unknownAfterMs -> status tidak
 *   diketahui, jadi "hilang" dicabut. Error tidak boleh membuat staf tercatat hilang -- dulu status
 *   hilang terakhir tertahan selamanya ("Belum terlihat") walau wajahnya sudah kembali.
 *
 * minMisses: tab dashboard di latar belakang membuat Chrome memperlambat timer cek (bisa sekali
 * per menit). Tanpa syarat ini, SATU frame tanpa wajah (staf sedang menunduk tepat saat diambil)
 * sudah lewat 30 detik sejak cek terakhir yang berhasil -> langsung "wajah hilang", lalu
 * "kembali" semenit kemudian. Itu yang membuat status wajah sering salah.
 */
export function createFaceState({ missingAfterMs, unknownAfterMs, minMisses = 1, now = () => Date.now() }) {
    let lastSeen = now()
    let lastChecked = now()
    let misses = 0
    let missing = false

    function clear() {
        lastSeen = now()
        lastChecked = now()
        misses = 0
        missing = false
        return missing
    }

    return {
        get missing() {
            return missing
        },
        reset: clear,
        cameraOff: clear,
        seen: clear,
        notSeen() {
            lastChecked = now()
            misses++
            if (now() - lastSeen >= missingAfterMs && misses >= minMisses) missing = true
            return missing
        },
        failed() {
            if (now() - lastChecked >= unknownAfterMs) {
                // Hitungan "tidak ada wajah" dimulai lagi dari nol setelah cek berhasil berikutnya.
                lastSeen = now()
                misses = 0
                missing = false
            }
            return missing
        },
    }
}
