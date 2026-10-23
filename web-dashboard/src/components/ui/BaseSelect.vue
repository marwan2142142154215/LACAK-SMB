<script setup>
import { ChevronDown } from '@lucide/vue'

defineProps({
    modelValue: { type: [String, Number, null], default: null },
    label: { type: String, default: null },
    hint: { type: String, default: null },
    required: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
})

defineEmits(['update:modelValue'])

/*
 * Nilai <option> selalu string di DOM -- kembalikan ke tipe aslinya
 * (number untuk id, null untuk opsi kosong) dengan membaca _value yang
 * disimpan Vue di elemen option, sama seperti perilaku v-model bawaan.
 */
function optionValue(event) {
    const option = event.target.selectedOptions[0]
    return option && '_value' in option ? option._value : event.target.value
}
</script>

<template>
    <label class="block">
        <span v-if="label" class="field-label">
            {{ label }}
            <span v-if="required" class="text-danger-400" aria-hidden="true">*</span>
        </span>
        <span class="relative block">
            <select
                :value="modelValue"
                :required="required"
                :disabled="disabled"
                class="field-control appearance-none pr-9"
                @change="$emit('update:modelValue', optionValue($event))"
            >
                <slot />
            </select>
            <ChevronDown class="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-base-500" />
        </span>
        <span v-if="hint" class="field-hint block">{{ hint }}</span>
    </label>
</template>
