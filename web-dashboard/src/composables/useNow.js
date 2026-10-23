import { onBeforeUnmount, onMounted, ref } from 'vue'

// Satu interval bersama untuk semua komponen yang menampilkan durasi
// berjalan (mis. puluhan ubin Live Kerja) -- bukan satu timer per ubin.
const now = ref(Date.now())
let subscribers = 0
let timer = null

/** Waktu sekarang (ms) yang diperbarui tiap detik selama komponen terpasang. */
export function useNow() {
    onMounted(() => {
        if (subscribers++ === 0) {
            now.value = Date.now()
            timer = setInterval(() => (now.value = Date.now()), 1000)
        }
    })
    onBeforeUnmount(() => {
        if (--subscribers === 0) {
            clearInterval(timer)
            timer = null
        }
    })
    return now
}

/** Durasi sejak `since` dalam format jam:menit:detik, mis. 01:04:09. */
export function formatElapsed(since, nowMs) {
    if (!since) return '--:--:--'
    const total = Math.max(0, Math.floor((nowMs - new Date(since).getTime()) / 1000))
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}
