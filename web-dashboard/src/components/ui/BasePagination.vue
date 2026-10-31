<script setup>
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { computed } from 'vue'

const props = defineProps({
    page: { type: Number, required: true },
    lastPage: { type: Number, required: true },
    total: { type: Number, required: true },
    perPage: { type: Number, required: true },
    disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:page'])

const from = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.perPage + 1))
const to = computed(() => Math.min(props.page * props.perPage, props.total))

// Nomor halaman yang ditampilkan: halaman 1, terakhir, dan 1 di kiri-kanan halaman aktif.
const pages = computed(() => {
    const wanted = new Set([1, props.lastPage, props.page - 1, props.page, props.page + 1])
    const sorted = [...wanted].filter((n) => n >= 1 && n <= props.lastPage).sort((a, b) => a - b)
    const result = []
    for (const [index, n] of sorted.entries()) {
        if (index > 0 && n - sorted[index - 1] > 1) result.push(null)
        result.push(n)
    }
    return result
})

function go(next) {
    if (props.disabled || next < 1 || next > props.lastPage || next === props.page) return
    emit('update:page', next)
}
</script>

<template>
    <nav
        v-if="total > 0"
        class="flex flex-wrap items-center justify-between gap-3 border-t border-base-800 px-5 py-3"
        aria-label="Halaman"
    >
        <p class="text-xs text-base-400">
            Menampilkan <span class="font-mono text-base-200">{{ from }}–{{ to }}</span> dari
            <span class="font-mono text-base-200">{{ total }}</span>
        </p>

        <div v-if="lastPage > 1" class="flex items-center gap-1">
            <button
                type="button"
                class="inline-flex size-8 items-center justify-center rounded-md border border-base-700 text-base-300 hover:bg-base-850 disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="disabled || page <= 1"
                aria-label="Halaman sebelumnya"
                @click="go(page - 1)"
            >
                <ChevronLeft class="size-4" />
            </button>

            <template v-for="(n, index) in pages" :key="n ?? `gap-${index}`">
                <span v-if="n === null" class="px-1 text-xs text-base-500" aria-hidden="true">…</span>
                <button
                    v-else
                    type="button"
                    class="inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 font-mono text-xs"
                    :class="
                        n === page
                            ? 'border-accent-500 bg-accent-500/15 text-base-50'
                            : 'border-base-700 text-base-300 hover:bg-base-850'
                    "
                    :aria-current="n === page ? 'page' : undefined"
                    :disabled="disabled"
                    @click="go(n)"
                >
                    {{ n }}
                </button>
            </template>

            <button
                type="button"
                class="inline-flex size-8 items-center justify-center rounded-md border border-base-700 text-base-300 hover:bg-base-850 disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="disabled || page >= lastPage"
                aria-label="Halaman berikutnya"
                @click="go(page + 1)"
            >
                <ChevronRight class="size-4" />
            </button>
        </div>
    </nav>
</template>
