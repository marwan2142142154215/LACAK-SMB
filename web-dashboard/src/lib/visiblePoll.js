/**
 * Pengganti setInterval untuk pembaruan berkala: tab yang terlihat diperbarui tiap `visibleMs`, tab di
 * latar belakang (disembunyikan / ditutupi jendela lain) hanya tiap `hiddenMs`. Staf membiarkan dashboard
 * terbuka sepanjang hari, jadi tab tersembunyi adalah sebagian besar pemanggilan berkala; mereka tetap
 * dapat info penting lewat sinyal realtime gateway, dan kembali segar begitu tab dibuka lagi.
 *
 * @param task fungsi yang dijalankan tiap kali giliran tiba
 * @param options.visibleMs jeda saat tab terlihat
 * @param options.hiddenMs jeda saat tab tersembunyi (bawaan 5x visibleMs)
 * @param options.isHidden / options.now disuntik saat uji
 */
export function createVisiblePoller(
    task,
    {
        visibleMs,
        hiddenMs = visibleMs * 5,
        isHidden = () => typeof document !== 'undefined' && document.hidden,
        now = Date.now,
    },
) {
    let timer = null
    let lastRunAt = now()

    function tick() {
        const wait = isHidden() ? hiddenMs : visibleMs
        if (now() - lastRunAt < wait) return
        lastRunAt = now()
        task()
    }

    return {
        tick,
        /** Dipanggil saat task dijalankan di luar giliran (mis. tab dibuka lagi), supaya giliran berikutnya dihitung dari sini. */
        markRun() {
            lastRunAt = now()
        },
        start() {
            clearInterval(timer)
            lastRunAt = now()
            // Detak lebih rapat dari visibleMs supaya tab yang baru terlihat tidak menunggu satu jeda penuh.
            timer = setInterval(tick, Math.min(visibleMs, 5_000))
        },
        stop() {
            clearInterval(timer)
            timer = null
        },
    }
}
