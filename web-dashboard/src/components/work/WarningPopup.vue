<script setup>
import { TriangleAlert } from '@lucide/vue'
import dayjs from 'dayjs'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import BaseButton from '@/components/ui/BaseButton.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { playWarningSound, primeWarningSound } from '@/lib/warningSound'
import { useChatStore } from '@/stores/chat'

/*
 * Popup peringatan dari leader ke atas. Menutupi layar dan tidak bisa
 * ditutup dengan Esc / klik di luar -- staf wajib menekan "Saya mengerti",
 * yang dicatat sebagai waktu konfirmasi. Peringatan baru datang seketika
 * lewat sinyal gateway (warning:new); cek berkala, pindah halaman, dan tab
 * yang dibuka lagi jadi cadangan. Nada peringatan berbunyi berulang selama
 * popup terbuka dan baru berhenti setelah semua peringatan dikonfirmasi.
 */
const POLL_MS = 30_000
const SOUND_REPEAT_MS = 3_000

const route = useRoute()
const toast = useToast()
const chat = useChatStore()
const pending = ref([])
const acknowledging = ref(false)
const current = computed(() => pending.value[0] ?? null)
const isSevere = computed(() => current.value?.level === 'keras')

async function load() {
    try {
        const { data } = await api.get('/staff-warnings/pending')
        pending.value = data.data.items
    } catch {
        // Dicoba lagi pada pengecekan berikutnya.
    }
}

async function acknowledge() {
    const warning = current.value
    acknowledging.value = true
    try {
        await api.post(`/staff-warnings/${warning.id}/acknowledge`)
        pending.value = pending.value.filter((item) => item.id !== warning.id)
    } catch (error) {
        toast.error('Konfirmasi belum tersimpan', error.response?.data?.message ?? 'Periksa koneksi lalu coba lagi.')
    } finally {
        acknowledging.value = false
    }
}

// Bunyi berulang selama ada peringatan yang belum dikonfirmasi.
let soundTimer = null
function stopSound() {
    clearInterval(soundTimer)
    soundTimer = null
}
watch(
    () => current.value?.id ?? null,
    (id) => {
        stopSound()
        if (id === null) return
        const ring = () => playWarningSound(isSevere.value)
        ring()
        soundTimer = setInterval(ring, SOUND_REPEAT_MS)
    },
)

let timer = null
const onVisible = () => document.visibilityState === 'visible' && load()
onMounted(() => {
    primeWarningSound()
    load()
    timer = setInterval(load, POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
    clearInterval(timer)
    stopSound()
    document.removeEventListener('visibilitychange', onVisible)
})
watch(() => route.name, load)
watch(() => chat.warningSignal, load)
</script>

<template>
    <DialogRoot :open="!!current">
        <DialogPortal>
            <DialogOverlay class="warning-overlay fixed inset-0 z-[90] bg-black/55 backdrop-blur-sm" />
            <DialogContent
                class="warning-content fixed top-1/2 left-1/2 z-[90] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border bg-base-900 shadow-(--shadow-raised) focus:outline-none"
                :class="isSevere ? 'border-danger-500/50' : 'border-warning-500/50'"
                @escape-key-down.prevent
                @pointer-down-outside.prevent
                @interact-outside.prevent
            >
                <div class="h-1.5" :class="isSevere ? 'bg-danger-500' : 'bg-warning-500'" />
                <div class="px-6 pt-6 pb-5">
                    <div class="flex items-center gap-3">
                        <span
                            class="flex size-11 shrink-0 items-center justify-center rounded-full"
                            :class="isSevere ? 'bg-danger-500/12 text-danger-400' : 'bg-warning-500/15 text-warning-400'"
                        >
                            <TriangleAlert class="size-5" />
                        </span>
                        <div class="min-w-0">
                            <p class="text-xs font-medium" :class="isSevere ? 'text-danger-400' : 'text-warning-400'">
                                {{ current?.level_label }}
                            </p>
                            <DialogTitle class="font-display text-lg leading-snug font-semibold text-base-50">
                                Peringatan dari {{ current?.issuer_name ?? 'atasan' }}
                            </DialogTitle>
                        </div>
                    </div>
                    <DialogDescription class="mt-4 text-[15px] leading-relaxed whitespace-pre-line text-base-100">
                        {{ current?.message }}
                    </DialogDescription>
                    <p class="mt-4 text-xs text-base-500">
                        Diberikan {{ current ? dayjs(current.created_at).format('dddd, D MMMM YYYY · HH:mm') : '' }}
                        <template v-if="pending.length > 1"> · {{ pending.length - 1 }} peringatan lain menunggu</template>
                    </p>
                </div>
                <footer class="flex items-center justify-between gap-3 border-t border-base-800 bg-base-850 px-6 py-4">
                    <p class="text-xs text-base-500">Atasan Anda akan melihat waktu konfirmasi ini.</p>
                    <BaseButton :variant="isSevere ? 'danger' : 'primary'" :loading="acknowledging" @click="acknowledge">
                        Saya mengerti
                    </BaseButton>
                </footer>
            </DialogContent>
        </DialogPortal>
    </DialogRoot>
</template>

<style scoped>
.warning-overlay[data-state='open'] {
    animation: fade-in 180ms ease-out;
}

.warning-content[data-state='open'] {
    animation: rise-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

@keyframes fade-in {
    from {
        opacity: 0;
    }
}

@keyframes rise-in {
    from {
        opacity: 0;
        translate: -50% calc(-50% + 12px);
    }
}

@media (prefers-reduced-motion: reduce) {
    .warning-overlay[data-state='open'],
    .warning-content[data-state='open'] {
        animation: none;
    }
}
</style>
