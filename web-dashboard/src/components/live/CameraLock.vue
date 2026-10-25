<script setup>
import { Camera, Square } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import { useToast } from '@/composables/useToast'
import { useLiveStore } from '@/stores/live'

// Kunci kamera: selama kerja, kamera WAJIB menyala. Kalau kamera berhenti
// mengirim gambar (dipakai aplikasi lain, izin dicabut, kabel USB lepas,
// ditutup lewat pengaturan), seluruh dashboard tertutup sampai kamera
// menyala lagi atau staf selesai kerja. Status CAMERA OFF tetap tercatat di
// log kerja selama terkunci. Kamera juga dicoba dinyalakan ulang otomatis,
// makin jarang kalau terus gagal (kamera yang dipakai aplikasi lain tidak
// perlu dibuka ulang tiap 10 detik sepanjang hari).
const AUTO_RETRY_DELAYS_MS = [10_000, 30_000, 60_000]
// Jeda diacak +-25% supaya puluhan staf yang terkunci bersamaan (mis. setelah
// server LiveKit tersendat) tidak membuka ulang kamera di detik yang sama.
const RETRY_JITTER = 0.25

const live = useLiveStore()
const toast = useToast()

const restarting = ref(false)
const ending = ref(false)
let retryTimer = null

// Saat istirahat kamera boleh mati. Kalau layar juga belum dibagikan, kunci
// layar (ScreenShareLock) tampil lebih dulu -- satu kunci sekali waktu.
const screenLocked = computed(() => live.screenRequired && !live.localScreenTrack)
// Saat LiveKit menyambung ulang kamera tidak dikunci -- yang putus server,
// dan kamera/layar diterbitkan ulang otomatis begitu tersambung.
const locked = computed(
    () => live.isBroadcasting && !live.reconnecting && !live.cameraLive && !live.onBreak && !screenLocked.value,
)

async function restartCamera({ silent = false } = {}) {
    if (restarting.value) return
    restarting.value = true
    try {
        await live.restartCamera()
    } catch (err) {
        if (!silent) toast.error('Kamera belum menyala', err.message)
    } finally {
        restarting.value = false
    }
}

// Selama terkunci, coba nyalakan ulang sendiri berkala -- sering kali kamera
// sudah dilepas aplikasi lain dan bisa langsung dipakai lagi.
function scheduleRetry(attempt) {
    const base = AUTO_RETRY_DELAYS_MS[Math.min(attempt, AUTO_RETRY_DELAYS_MS.length - 1)]
    const delay = base * (1 - RETRY_JITTER + Math.random() * 2 * RETRY_JITTER)
    retryTimer = setTimeout(async () => {
        await restartCamera({ silent: true })
        if (locked.value) scheduleRetry(attempt + 1)
    }, delay)
}

watch(locked, (isLocked) => {
    clearTimeout(retryTimer)
    retryTimer = null
    if (isLocked) scheduleRetry(0)
})
onBeforeUnmount(() => clearTimeout(retryTimer))

async function endWork() {
    ending.value = true
    try {
        await live.endWork()
        toast.success('Selesai kerja', 'Siaran kamera & layar dihentikan')
    } catch (err) {
        toast.error('Gagal menghentikan siaran', err.response?.data?.message)
    } finally {
        ending.value = false
    }
}
</script>

<template>
    <DialogRoot :open="locked">
        <DialogPortal>
            <DialogOverlay class="fixed inset-0 z-[60] bg-base-950/80 backdrop-blur-md" />
            <DialogContent
                class="fixed top-1/2 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-base-800 bg-base-900 p-6 shadow-(--shadow-raised) focus:outline-none"
                @escape-key-down.prevent
                @pointer-down-outside.prevent
                @interact-outside.prevent
            >
                <span class="flex size-11 items-center justify-center rounded-xl bg-st-camera/10 text-st-camera">
                    <Camera class="size-6" />
                </span>
                <DialogTitle class="mt-4 font-display text-xl font-semibold text-base-50">Kamera wajib menyala</DialogTitle>
                <DialogDescription class="mt-2 text-sm text-pretty text-base-400">
                    Kamera Anda berhenti mengirim gambar, jadi status Anda <strong class="text-st-camera">Camera off</strong> dan tercatat
                    di log kerja. Tutup aplikasi lain yang memakai kamera (Zoom, Teams, WhatsApp, tab lain), pastikan izin kamera di browser
                    diizinkan dan kabel kamera terpasang, lalu tekan <strong class="text-base-100">Nyalakan kamera</strong>.
                </DialogDescription>
                <p v-if="live.cameraProblem" class="mt-3 rounded-md bg-st-camera/10 px-3 py-2 text-xs text-pretty text-st-camera">
                    {{ live.cameraProblem }}
                </p>
                <p class="mt-3 text-xs text-base-500">Kamera juga dicoba dinyalakan ulang otomatis secara berkala.</p>
                <div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <BaseButton variant="ghost" :loading="ending" :disabled="restarting" @click="endWork">
                        <Square class="size-4" />
                        Selesai kerja
                    </BaseButton>
                    <BaseButton :loading="restarting" :disabled="ending" @click="restartCamera()">
                        <Camera class="size-4" />
                        Nyalakan kamera
                    </BaseButton>
                </div>
            </DialogContent>
        </DialogPortal>
    </DialogRoot>
</template>
