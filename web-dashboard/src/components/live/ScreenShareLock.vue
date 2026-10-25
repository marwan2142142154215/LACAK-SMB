<script setup>
import { MonitorUp, Square } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import { useToast } from '@/composables/useToast'
import { useLiveStore } from '@/stores/live'

// Kunci layar: siaran dari komputer WAJIB membagikan seluruh layar. Kalau
// staf menekan "Stop sharing" milik browser di tengah kerja, seluruh
// dashboard tertutup sampai layar dibagikan lagi (atau staf selesai kerja).
// Status SCREEN OFF tetap tercatat di log selama terkunci. Dipasang di
// AppShell supaya berlaku di semua halaman, bukan cuma Live Kerja.
const live = useLiveStore()
const toast = useToast()

const sharing = ref(false)
const ending = ref(false)

// Staf bekerja di aplikasi lain, jadi kunci di halaman ini sering tidak
// terlihat. Selama layar tidak dibagikan: notifikasi desktop (izinnya diminta
// saat Mulai kerja) diulang tiap ALERT_REPEAT_MS, dan judul tab berkedip.
const ALERT_REPEAT_MS = 60_000
const TITLE_BLINK_MS = 1_000
const ALERT_TITLE = '⚠ Layar tidak dibagikan'
let alertTimer = null
let blinkTimer = null
let notification = null
let originalTitle = null

// Saat istirahat layar boleh dimatikan; begitu "Lanjut kerja", kunci aktif lagi.
// screenLive: track layar masih ada tapi berhenti mengirim juga dikunci.
// Saat LiveKit menyambung ulang tidak dikunci: layar yang masih dibagikan
// diterbitkan ulang otomatis begitu tersambung (live.republishMissingTracks).
const locked = computed(
    () =>
        live.isBroadcasting &&
        !live.reconnecting &&
        live.screenRequired &&
        (!live.localScreenTrack || !live.screenLive) &&
        !live.onBreak,
)

function notifyScreenOff() {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    notification?.close()
    notification = new Notification('Layar Live Kerja tidak dibagikan', {
        body: 'Status Anda SCREEN OFF dan waktu ini tidak dihitung sebagai jam kerja. Klik untuk membagikan layar lagi.',
        tag: 'lacak-screen-off',
        requireInteraction: true,
    })
    notification.onclick = () => {
        window.focus()
        notification?.close()
    }
}

function startAlert() {
    notifyScreenOff()
    alertTimer = setInterval(notifyScreenOff, ALERT_REPEAT_MS)
    originalTitle = document.title
    blinkTimer = setInterval(() => {
        document.title = document.title === ALERT_TITLE ? originalTitle : ALERT_TITLE
    }, TITLE_BLINK_MS)
}

function stopAlert() {
    clearInterval(alertTimer)
    clearInterval(blinkTimer)
    alertTimer = null
    blinkTimer = null
    notification?.close()
    notification = null
    if (originalTitle !== null) document.title = originalTitle
    originalTitle = null
}

// Layar yang terlepas sesaat (diterbitkan ulang otomatis) tidak perlu
// diperingatkan -- baru setelah ALERT_DELAY_MS masih terkunci.
const ALERT_DELAY_MS = 10_000
let alertDelay = null

// Chrome kantor (kebijakan ScreenCaptureWithoutGestureAllowedForOrigins, lihat
// docs/chrome-kantor.md): dialog pilih layar boleh dibuka tanpa klik, jadi
// begitu staf menekan "Stop sharing" dialognya langsung dibuka lagi, dan
// diulang tiap AUTO_SHARE_RETRY_MS kalau dibatalkan. Di Chrome biasa browser
// menolaknya (butuh klik) -> berhenti mencoba, staf memakai tombol Bagikan lagi.
const AUTO_SHARE_DELAY_MS = 3_000
const AUTO_SHARE_RETRY_MS = 30_000
let autoShareTimer = null
let autoShareAllowed = true

async function autoShare() {
    autoShareTimer = null
    if (!locked.value || !autoShareAllowed || sharing.value) return
    sharing.value = true
    try {
        await live.setScreenShare(true)
    } catch (err) {
        if (err.needsGesture) autoShareAllowed = false
    } finally {
        sharing.value = false
    }
    if (locked.value && autoShareAllowed) autoShareTimer = setTimeout(autoShare, AUTO_SHARE_RETRY_MS)
}

watch(locked, (isLocked) => {
    clearTimeout(alertDelay)
    clearTimeout(autoShareTimer)
    stopAlert()
    if (isLocked) {
        alertDelay = setTimeout(startAlert, ALERT_DELAY_MS)
        autoShareTimer = setTimeout(autoShare, AUTO_SHARE_DELAY_MS)
    }
})
onBeforeUnmount(() => {
    clearTimeout(alertDelay)
    clearTimeout(autoShareTimer)
    stopAlert()
})

async function shareAgain() {
    sharing.value = true
    try {
        await live.setScreenShare(true)
    } catch (err) {
        toast.error('Layar belum dibagikan', err.message)
    } finally {
        sharing.value = false
    }
}

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
                <span class="flex size-11 items-center justify-center rounded-xl bg-st-screen/10 text-st-screen">
                    <MonitorUp class="size-6" />
                </span>
                <DialogTitle class="mt-4 font-display text-xl font-bold text-base-50 tracking-[-0.015em]">Layar wajib dibagikan</DialogTitle>
                <DialogDescription class="mt-2 text-sm text-pretty text-base-400">
                    Layar Anda sedang tidak dibagikan (berbagi layar dihentikan, atau halaman baru saja dimuat ulang), jadi status Anda
                    <strong class="text-st-screen">Screen off</strong> dan tercatat di log kerja.
                    <strong class="text-base-100">Selama layar tidak dibagikan, waktu ini tidak dihitung sebagai jam kerja.</strong> Tekan
                    <strong class="text-base-100">Bagikan lagi</strong>, pilih tab <em>Entire screen</em> (Seluruh layar), lalu tekan Share
                    untuk melanjutkan kerja.
                </DialogDescription>
                <div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <BaseButton variant="ghost" :loading="ending" :disabled="sharing" @click="endWork">
                        <Square class="size-4" />
                        Selesai kerja
                    </BaseButton>
                    <BaseButton :loading="sharing" :disabled="ending" @click="shareAgain">
                        <MonitorUp class="size-4" />
                        Bagikan lagi
                    </BaseButton>
                </div>
            </DialogContent>
        </DialogPortal>
    </DialogRoot>
</template>
