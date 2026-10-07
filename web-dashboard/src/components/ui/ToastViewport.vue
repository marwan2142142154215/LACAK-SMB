<script setup>
import { CheckCircle2, Info, XCircle } from '@lucide/vue'
import { ToastDescription, ToastPortal, ToastProvider, ToastRoot, ToastTitle, ToastViewport } from 'reka-ui'

import { useToast } from '@/composables/useToast'

const { toasts, dismiss } = useToast()

const iconByVariant = {
    success: CheckCircle2,
    error: XCircle,
    info: Info,
}

const borderByVariant = {
    success: 'border-accent-500/40',
    error: 'border-danger-500/40',
    info: 'border-base-600',
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
                class="data-[state=open]:animate-in data-[state=open]:slide-in-from-right-8 data-[state=closed]:animate-out data-[state=closed]:fade-out-80 rounded-xl border bg-base-850/95 p-4 shadow-2xl shadow-black/40 backdrop-blur"
                :class="borderByVariant[toast.variant]"
                @update:open="(open) => !open && dismiss(toast.id)"
            >
                <div class="flex items-start gap-3">
                    <component
                        :is="iconByVariant[toast.variant]"
                        class="mt-0.5 size-5 shrink-0"
                        :class="iconColorByVariant[toast.variant]"
                    />
                    <div class="min-w-0">
                        <ToastTitle class="text-sm font-semibold text-base-50">
                            {{ toast.title }}
                        </ToastTitle>
                        <ToastDescription v-if="toast.description" class="mt-1 text-sm text-base-300">
                            {{ toast.description }}
                        </ToastDescription>
                    </div>
                </div>
            </ToastRoot>
            <ToastViewport class="fixed top-4 right-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3 outline-none" />
        </ToastPortal>
    </ToastProvider>
</template>
