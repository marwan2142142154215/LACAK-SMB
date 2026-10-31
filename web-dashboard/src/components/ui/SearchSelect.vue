<script setup>
import { Check, ChevronDown, Search } from '@lucide/vue'
import {
    ListboxContent,
    ListboxFilter,
    ListboxItem,
    ListboxRoot,
    PopoverContent,
    PopoverPortal,
    PopoverRoot,
    PopoverTrigger,
} from 'reka-ui'
import { computed, ref, watch } from 'vue'

/*
 * Dropdown yang bisa dicari (untuk daftar panjang, mis. 50+ site): klik membuka panel ke bawah
 * berisi kolom cari + daftar. Panah atas/bawah + Enter memilih, Esc menutup.
 *
 * options: [{ value, label, badge? }] -- badge = angka kecil di kanan (mis. jumlah staf live).
 */
const props = defineProps({
    modelValue: { type: [String, Number, null], default: null },
    options: { type: Array, default: () => [] },
    ariaLabel: { type: String, required: true },
    searchPlaceholder: { type: String, default: 'Cari…' },
    emptyText: { type: String, default: 'Tidak ada yang cocok' },
    disabled: { type: Boolean, default: false },
    /** Tinggi 36px untuk filter di toolbar (bawaan 40px). */
    compact: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const query = ref('')

const selected = computed(() => props.options.find((option) => option.value === props.modelValue) ?? null)

const filtered = computed(() => {
    const term = query.value.trim().toLowerCase()
    return term ? props.options.filter((option) => option.label.toLowerCase().includes(term)) : props.options
})

// Panel selalu dibuka dengan pencarian kosong.
watch(open, (isOpen) => {
    if (isOpen) query.value = ''
})

function choose(value) {
    open.value = false
    if (value !== undefined && value !== props.modelValue) emit('update:modelValue', value)
}

const badgeClass = (option, active) =>
    active ? 'bg-base-950/20' : option.badge ? 'bg-accent-500/12 text-accent-400' : 'bg-base-850 text-base-500'
</script>

<template>
    <!-- PopoverRoot tidak punya elemen sendiri; pembungkus ini yang menerima class dari pemanggil (lebar, posisi). -->
    <div class="min-w-0">
    <PopoverRoot v-model:open="open">
        <PopoverTrigger
            :disabled="disabled"
            :aria-label="ariaLabel"
            class="field-control flex w-full items-center justify-between gap-2 py-0 text-left text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
            :class="compact ? 'h-9' : 'h-10'"
        >
            <span class="flex min-w-0 items-center gap-2">
                <span class="truncate">{{ selected?.label ?? '—' }}</span>
                <span
                    v-if="selected && selected.badge !== undefined"
                    class="min-w-5 shrink-0 rounded-full px-1.5 py-px text-center font-mono text-[11px] tabular-nums"
                    :class="badgeClass(selected, false)"
                    >{{ selected.badge }}</span
                >
            </span>
            <ChevronDown
                class="size-4 shrink-0 text-base-500 transition-transform"
                :class="open && 'rotate-180'"
            />
        </PopoverTrigger>
        <PopoverPortal>
            <PopoverContent
                align="end"
                side="bottom"
                :side-offset="6"
                :collision-padding="12"
                :avoid-collisions="true"
                class="menu-content z-[60] w-(--reka-popover-trigger-width) min-w-64 overflow-hidden rounded-xl border border-base-700 bg-base-850 shadow-xl shadow-black/50"
            >
                <ListboxRoot
                    :model-value="modelValue"
                    :highlight-on-hover="true"
                    @update:model-value="choose"
                >
                    <div class="relative border-b border-base-700 p-2">
                        <Search class="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-base-500" />
                        <ListboxFilter
                            v-model="query"
                            :auto-focus="true"
                            :placeholder="searchPlaceholder"
                            :aria-label="searchPlaceholder"
                            autocomplete="off"
                            class="field-control h-9 pl-9 text-sm"
                        />
                    </div>
                    <ListboxContent class="max-h-72 overflow-y-auto p-1" :aria-label="ariaLabel">
                        <ListboxItem
                            v-for="option in filtered"
                            :key="String(option.value)"
                            :value="option.value"
                            class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm text-base-100 outline-none select-none data-[highlighted]:bg-base-800 data-[state=checked]:text-accent-400"
                        >
                            <span class="flex min-w-0 items-center gap-2">
                                <Check
                                    class="size-4 shrink-0"
                                    :class="option.value === modelValue ? 'opacity-100' : 'opacity-0'"
                                />
                                <span class="truncate">{{ option.label }}</span>
                            </span>
                            <span
                                v-if="option.badge !== undefined"
                                class="min-w-5 shrink-0 rounded-full px-1.5 py-px text-center font-mono text-[11px] tabular-nums"
                                :class="badgeClass(option, false)"
                                >{{ option.badge }}</span
                            >
                        </ListboxItem>
                        <p v-if="filtered.length === 0" class="px-3 py-4 text-center text-sm text-base-400">
                            {{ emptyText }}<template v-if="query.trim()"> “{{ query.trim() }}”</template>
                        </p>
                    </ListboxContent>
                </ListboxRoot>
            </PopoverContent>
        </PopoverPortal>
    </PopoverRoot>
    </div>
</template>
