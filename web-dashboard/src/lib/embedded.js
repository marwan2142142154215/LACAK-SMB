/**
 * Dashboard dibuka di dalam APK Live Kerja (WebView menambahkan "LacakLiveApp" ke user agent).
 * APK punya navigasi & siaran sendiri, jadi menu samping, bar status, dan siaran web disembunyikan.
 */
export const isEmbedded = typeof navigator !== 'undefined' && /\bLacakLiveApp\b/.test(navigator.userAgent)
