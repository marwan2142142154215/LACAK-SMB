<script setup>
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'

import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps({
    open: { type: Boolean, default: false },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    confirmLabel: { type: String, default: 'Konfirmasi' },
    confirmVariant: { type: String, default: 'danger' },
    loading: { type: Boolean, default: false },
})

const emit = defineEmits(['update:open', 'confirm'])
</script>

<template>
    <DialogRoot :open="open" @update:open="(v) => emit('update:open', v)">
        <DialogPortal>
            <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
            <DialogContent
                class="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl shadow-black/50 focus:outline-none"
            >
                <DialogTitle class="text-base font-semibold text-base-50">{{ title }}</DialogTitle>
                <DialogDescription :class="description ? 'mt-2 text-sm text-base-400' : 'sr-only'">
                    {{ description || title }}
                </DialogDescription>
                <div class="mt-6 flex justify-end gap-3">
                    <BaseButton variant="ghost" :disabled="loading" @click="emit('update:open', false)">Batal</BaseButton>
                    <BaseButton :variant="confirmVariant" :loading="loading" @click="emit('confirm')">
                        {{ confirmLabel }}
                    </BaseButton>
                </div>
            </DialogContent>
        </DialogPortal>
    </DialogRoot>
</template>
