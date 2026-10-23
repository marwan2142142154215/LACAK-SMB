<script setup>
import { CheckCircle2, Info, X, XCircle } from '@lucide/vue'
import { ToastClose, ToastDescription, ToastPortal, ToastProvider, ToastRoot, ToastTitle, ToastViewport } from 'reka-ui'

import { useToast } from '@/composables/useToast'

const { toasts, dismiss } = useToast()

const iconByVariant = {
    success: CheckCircle2,
    error: XCircle,
    info: Info,
}

// Garis warna di tepi kiri = jenis pesan, seperti lampu indikator panel
const railByVariant = {
    success: 'before:bg-accent-400',
    error: 'before:bg-danger-400',
    info: 'before:bg-base-500',
}

const iconColorByVariant = {
    success: 'text-accent-400',
    error: 'text-danger-400',
    info: 'text-base-300',
}
</script>

<template>
    <ToastProvider swipe-direction="right" :duration="5000">
        <ToastPortal>
            <ToastRoot
                v-for="toast in toasts"
                :key="toast.id"
                :open="toast.open"
                class="toast relative overflow-hidden rounded-lg border border-base-700 bg-base-850/95 py-3.5 pr-10 pl-4 shadow-2xl shadow-black/50 backdrop-blur before:absolute before:inset-y-0 before:left-0 before:w-[3px]"
                :class="railByVariant[toast.variant]"
                @update:open="(open) => !open && dismiss(toast.id)"
            >
                <div class="flex items-start gap-3">
                    <component
                        :is="iconByVariant[toast.variant]"
                        class="mt-px size-[18px] shrink-0"
                        :class="iconColorByVariant[toast.variant]"
                    />
                    <div class="min-w-0">
                        <ToastTitle class="text-sm font-semibold text-base-50">
                            {{ toast.title }}
                        </ToastTitle>
                        <ToastDescription v-if="toast.description" class="mt-0.5 text-sm text-pretty text-base-300">
                            {{ toast.description }}
                        </ToastDescription>
                    </div>
                </div>
                <ToastClose class="absolute top-3 right-3 rounded text-base-500 hover:text-base-100" aria-label="Tutup">
                    <X class="size-4" />
                </ToastClose>
            </ToastRoot>
            <ToastViewport class="fixed top-4 right-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2.5 outline-none" />
        </ToastPortal>
    </ToastProvider>
</template>

<style scoped>
.toast[data-state='open'] {
    animation: toast-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.toast[data-state='closed'] {
    animation: toast-out 150ms ease-in forwards;
}

@keyframes toast-in {
    from {
        opacity: 0;
        transform: translateX(16px);
    }
}

@keyframes toast-out {
    to {
        opacity: 0;
        transform: translateX(16px);
    }
}

@media (prefers-reduced-motion: reduce) {
    .toast[data-state] {
        animation: none;
    }
}
</style>
