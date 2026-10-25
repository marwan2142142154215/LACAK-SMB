<script setup>
import { X } from '@lucide/vue'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'

defineProps({
    open: { type: Boolean, default: false },
    title: { type: String, required: true },
    // Kalimat penjelas di bawah judul; kosong = tetap ada untuk pembaca layar
    description: { type: String, default: '' },
    size: { type: String, default: 'md' }, // sm | md | lg
})

const emit = defineEmits(['update:open'])

const widths = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-xl' }
</script>

<!-- Satu bentuk dialog untuk semua form & konfirmasi di dashboard -->
<template>
    <DialogRoot :open="open" @update:open="(v) => emit('update:open', v)">
        <DialogPortal>
            <DialogOverlay class="dialog-overlay fixed inset-0 z-50 bg-base-950/80 backdrop-blur-sm" />
            <DialogContent
                class="dialog-content fixed top-1/2 left-1/2 z-50 flex max-h-[88dvh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-base-700/80 bg-base-900 shadow-(--shadow-raised) focus:outline-none"
                :class="widths[size]"
            >
                <header
                    class="flex items-start justify-between gap-4 px-6 pt-5 pb-4"
                    :class="($slots.default || $slots.footer) && 'border-b border-base-800'"
                >
                    <div class="min-w-0">
                        <DialogTitle class="font-display text-lg leading-snug font-bold tracking-[-0.015em] text-base-50">{{ title }}</DialogTitle>
                        <DialogDescription :class="description ? 'mt-1 text-sm text-pretty text-base-400' : 'sr-only'">
                            {{ description || title }}
                        </DialogDescription>
                    </div>
                    <DialogClose
                        class="-mt-0.5 -mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-base-500 transition-colors hover:bg-base-800 hover:text-base-100 focus-visible:outline-2 focus-visible:outline-accent-400"
                        aria-label="Tutup"
                    >
                        <X class="size-4" />
                    </DialogClose>
                </header>
                <div v-if="$slots.default" class="overflow-y-auto px-6 py-5">
                    <slot />
                </div>
                <footer v-if="$slots.footer" class="flex justify-end gap-2 border-t border-base-800 px-6 py-4">
                    <slot name="footer" />
                </footer>
            </DialogContent>
        </DialogPortal>
    </DialogRoot>
</template>

<style scoped>
.dialog-overlay[data-state='open'] {
    animation: fade-in 160ms ease-out;
}

.dialog-content[data-state='open'] {
    animation: rise-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

@keyframes fade-in {
    from {
        opacity: 0;
    }
}

@keyframes rise-in {
    from {
        opacity: 0;
        translate: -50% calc(-50% + 8px);
    }
}

@media (prefers-reduced-motion: reduce) {
    .dialog-overlay[data-state='open'],
    .dialog-content[data-state='open'] {
        animation: none;
    }
}
</style>
