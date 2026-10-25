<script setup>
import { MonitorUp, Square } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, ref } from 'vue'

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

// Saat istirahat layar boleh dimatikan; begitu "Lanjut kerja", kunci aktif lagi.
// screenLive: track layar masih ada tapi berhenti mengirim juga dikunci.
const locked = computed(() => live.isBroadcasting && live.screenRequired && (!live.localScreenTrack || !live.screenLive) && !live.onBreak)

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
                <DialogTitle class="mt-4 font-display text-xl font-semibold text-base-50">Layar wajib dibagikan</DialogTitle>
                <DialogDescription class="mt-2 text-sm text-pretty text-base-400">
                    Layar Anda sedang tidak dibagikan (berbagi layar dihentikan, atau halaman baru saja dimuat ulang), jadi status Anda
                    <strong class="text-st-screen">Screen off</strong> dan tercatat di log kerja. Tekan
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
