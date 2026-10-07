<script setup>
defineProps({
    modelValue: { type: [String, Number], default: '' },
    label: { type: String, default: null },
    type: { type: String, default: 'text' },
    placeholder: { type: String, default: '' },
    error: { type: String, default: null },
    required: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    autocomplete: { type: String, default: 'off' },
})

defineEmits(['update:modelValue'])
</script>

<template>
    <label class="block">
        <span v-if="label" class="mb-1.5 block text-xs font-medium text-base-300">
            {{ label }}
            <span v-if="required" class="text-danger-400">*</span>
        </span>
        <input
            :value="modelValue"
            :type="type"
            :placeholder="placeholder"
            :disabled="disabled"
            :autocomplete="autocomplete"
            class="w-full rounded-lg border bg-base-850 px-3.5 py-2.5 text-sm text-base-50 placeholder-base-500 outline-none transition-colors focus:border-accent-500 disabled:cursor-not-allowed disabled:opacity-50"
            :class="error ? 'border-danger-500' : 'border-base-700'"
            @input="$emit('update:modelValue', $event.target.value)"
        />
        <span v-if="error" class="mt-1.5 block text-xs text-danger-400">{{ error }}</span>
    </label>
</template>
