<script setup>
import { Search } from '@lucide/vue'
import { computed, ref } from 'vue'

/*
 * Pemilih banyak site: pencarian, "pilih semua yang tampil", dan "kosongkan".
 * Dipakai di form ubah staf (satu user) dan dialog atur site massal.
 * Nilai = daftar id site terpilih; pilihan yang sedang tidak tampil (tersaring)
 * tidak ikut berubah saat "pilih semua" / "kosongkan".
 */
const props = defineProps({
    sites: { type: Array, required: true },
    modelValue: { type: Array, default: () => [] },
    label: { type: String, default: 'Site' },
    disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const query = ref('')

const visibleSites = computed(() => {
    const term = query.value.trim().toLowerCase()
    return term ? props.sites.filter((site) => site.name.toLowerCase().includes(term)) : props.sites
})

const selected = computed(() => new Set(props.modelValue))
const allVisibleSelected = computed(
    () => visibleSites.value.length > 0 && visibleSites.value.every((site) => selected.value.has(site.id)),
)

function toggle(siteId) {
    const next = new Set(selected.value)
    if (next.has(siteId)) next.delete(siteId)
    else next.add(siteId)
    emit('update:modelValue', [...next])
}

function selectVisible() {
    const next = new Set(selected.value)
    for (const site of visibleSites.value) next.add(site.id)
    emit('update:modelValue', [...next])
}

function clearVisible() {
    const hidden = new Set(visibleSites.value.map((site) => site.id))
    emit(
        'update:modelValue',
        props.modelValue.filter((id) => !hidden.has(id)),
    )
}
</script>

<template>
    <fieldset :disabled="disabled" :class="disabled && 'opacity-50'">
        <legend class="field-label">
            {{ label }}
            <span class="ml-1 font-mono text-base-500">{{ modelValue.length }} dari {{ sites.length }} dipilih</span>
        </legend>

        <div class="mb-2 flex flex-wrap items-center gap-2">
            <label class="relative min-w-40 flex-1">
                <span class="sr-only">Cari site</span>
                <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                <input v-model="query" type="search" maxlength="100" placeholder="Cari site…" class="field-control h-9 pl-9 text-sm" />
            </label>
            <button
                type="button"
                class="h-9 rounded-md border border-base-700 px-3 text-xs font-medium text-base-200 hover:bg-base-850 disabled:opacity-40"
                :disabled="visibleSites.length === 0 || allVisibleSelected"
                @click="selectVisible"
            >
                Pilih semua{{ query.trim() ? ' yang tampil' : '' }}
            </button>
            <button
                type="button"
                class="h-9 rounded-md border border-base-700 px-3 text-xs font-medium text-base-200 hover:bg-base-850 disabled:opacity-40"
                :disabled="!visibleSites.some((site) => selected.has(site.id))"
                @click="clearVisible"
            >
                Kosongkan
            </button>
        </div>

        <div class="max-h-52 space-y-0.5 overflow-y-auto rounded-lg border border-base-700 bg-base-850 p-1.5">
            <p v-if="visibleSites.length === 0" class="px-2 py-3 text-center text-xs text-base-500">
                {{ sites.length === 0 ? 'Belum ada site.' : 'Tidak ada site yang cocok.' }}
            </p>
            <label
                v-for="site in visibleSites"
                :key="site.id"
                class="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-base-200 hover:bg-base-800"
            >
                <input type="checkbox" :checked="selected.has(site.id)" class="size-4 accent-accent-500" @change="toggle(site.id)" />
                <span class="min-w-0 truncate">{{ site.name }}</span>
            </label>
        </div>
    </fieldset>
</template>
