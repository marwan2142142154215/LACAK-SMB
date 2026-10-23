/*
 * Service worker minimal supaya dashboard bisa di-install sebagai aplikasi
 * (PWA) di HP & PC. SENGAJA tidak meng-cache apa pun: data radar, token
 * LiveKit, dan JS hasil build harus selalu yang terbaru (lihat catatan
 * Cache-Control no-store di vite.config.js) -- cache SW malah bikin staf
 * memakai versi lama tanpa sadar. Satu-satunya tambahan: pesan offline yang
 * jelas saat halaman dibuka tanpa koneksi, bukan layar error browser.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
    if (event.request.mode !== 'navigate') return

    event.respondWith(
        fetch(event.request).catch(
            () =>
                new Response(
                    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                        '<title>Lacak SMB</title><body style="background:#05070a;color:#e4e8ef;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
                        '<div><h1 style="font-size:18px">Tidak ada koneksi internet</h1><p style="color:#9aa4b6;font-size:14px">Live Kerja butuh internet. Sambungkan lalu muat ulang.</p></div>',
                    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
                ),
        ),
    )
})
