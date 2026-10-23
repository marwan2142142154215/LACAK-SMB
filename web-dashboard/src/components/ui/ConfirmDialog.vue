<script setup>
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'

defineProps({
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
    <BaseDialog :open="open" :title="title" :description="description" size="sm" @update:open="(v) => emit('update:open', v)">
        <template v-if="$slots.default" #default><slot /></template>
        <template #footer>
            <BaseButton variant="ghost" :disabled="loading" @click="emit('update:open', false)">Batal</BaseButton>
            <BaseButton :variant="confirmVariant" :loading="loading" @click="emit('confirm')">
                {{ confirmLabel }}
            </BaseButton>
        </template>
    </BaseDialog>
</template>
