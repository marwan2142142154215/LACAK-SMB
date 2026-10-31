<script setup>
import { Search, X } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import SitePicker from '@/components/staff/SitePicker.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

/*
 * Update massal staf: pilih email-email yang mau diupdate, lalu (semuanya opsional, minimal satu)
 * ganti peran, aktifkan / suspen, dan atur akses site -- sekali jalan untuk semua yang dipilih.
 */
const props = defineProps({
    open: { type: Boolean, default: false },
    /** Staf yang sudah dicentang di tabel: [{ id, name, email }]. */
    preselected: { type: Array, default: () => [] },
    roles: { type: Array, default: () => [] },
    organizations: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:open', 'done'])

const toast = useToast()

const SEARCH_DEBOUNCE_MS = 300
const MAX_USERS = 200
const SEARCH_RESULTS = 8

const selected = ref([])
const search = ref('')
const results = ref([])
const searching = ref(false)
const role = ref('')
const status = ref('')
const siteMode = ref('')
const allSites = ref(false)
const sites = ref([])
const submitting = ref(false)
const outcome = ref(null)
let searchTimer = null
let searchSeq = 0

const SITE_MODES = [
    { value: '', label: 'Tidak diubah' },
    { value: 'add', label: 'Tambah site (akses lama dibiarkan)' },
    { value: 'replace', label: 'Ganti site (akses lama dilepas)' },
    { value: 'remove', label: 'Cabut site' },
]

watch(
    () => props.open,
    (open) => {
        if (!open) return
        selected.value = props.preselected.map((user) => ({ id: user.id, name: user.name, email: user.email }))
        search.value = ''
        results.value = []
        role.value = ''
        status.value = ''
        siteMode.value = ''
        allSites.value = false
        sites.value = []
        outcome.value = null
    },
)

const selectedIds = computed(() => selected.value.map((user) => user.id))
const siteReady = computed(() => siteMode.value === '' || allSites.value || sites.value.length > 0)
const hasChange = computed(() => Boolean(role.value || status.value || siteMode.value))
const canSubmit = computed(
    () => selected.value.length > 0 && selected.value.length <= MAX_USERS && hasChange.value && siteReady.value,
)

const roleLabel = computed(() => props.roles.find((item) => item.name === role.value)?.label ?? '')

async function runSearch() {
    const term = search.value.trim()
    if (!term) {
        results.value = []
        return
    }
    const seq = ++searchSeq
    searching.value = true
    try {
        const response = await api.get('/users', { params: { search: term, per_page: SEARCH_RESULTS } })
        if (seq === searchSeq) results.value = response.data.data.items
    } catch (err) {
        if (seq === searchSeq) toast.error('Gagal mencari staf', err.response?.data?.message)
    } finally {
        if (seq === searchSeq) searching.value = false
    }
}

watch(search, () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS)
})
onBeforeUnmount(() => clearTimeout(searchTimer))

const isPicked = (user) => selectedIds.value.includes(user.id)

function toggle(user) {
    selected.value = isPicked(user)
        ? selected.value.filter((item) => item.id !== user.id)
        : [...selected.value, { id: user.id, name: user.name, email: user.email }]
}

function addAllResults() {
    const fresh = results.value.filter((user) => !isPicked(user))
    selected.value = [...selected.value, ...fresh.map((user) => ({ id: user.id, name: user.name, email: user.email }))]
}

async function submit() {
    submitting.value = true
    try {
        const payload = { user_ids: selectedIds.value }
        if (role.value) payload.role = role.value
        if (status.value) payload.status = status.value
        if (siteMode.value) {
            payload.site_mode = siteMode.value
            if (allSites.value) payload.all_sites = true
            else payload.organization_ids = sites.value
        }
        const response = await api.post('/users/bulk-update', payload)
        outcome.value = response.data.data
        toast.success(response.data.message)
        emit('done')
    } catch (err) {
        const errors = err.response?.data?.errors
        const detail = errors ? Object.values(errors).flat().join(' ') : err.response?.data?.message
        toast.error('Gagal memperbarui staf', detail)
    } finally {
        submitting.value = false
    }
}

const summary = computed(() => {
    const parts = []
    if (role.value) parts.push(`peran → ${roleLabel.value}`)
    if (status.value) parts.push(status.value === 'active' ? 'diaktifkan' : 'disuspen')
    if (siteMode.value) {
        const target = allSites.value ? 'semua site' : `${sites.value.length} site`
        parts.push({ add: `tambah ${target}`, replace: `ganti dengan ${target}`, remove: `cabut ${target}` }[siteMode.value])
    }
    return parts.join(' · ')
})
</script>

<template>
    <BaseDialog
        :open="open"
        title="Update staf"
        description="Pilih email yang mau diupdate, lalu atur peran, status, dan site sekaligus. Yang dibiarkan 'Tidak diubah' tidak disentuh."
        size="lg"
        @update:open="(v) => emit('update:open', v)"
    >
        <div v-if="outcome" class="space-y-3 text-sm">
            <ul class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <li class="rounded-lg border border-base-800 p-3">
                    <p class="text-xs text-base-500">Peran diganti</p>
                    <p class="font-mono text-lg text-base-50">{{ outcome.role_changed }}</p>
                </li>
                <li class="rounded-lg border border-base-800 p-3">
                    <p class="text-xs text-base-500">Diaktifkan</p>
                    <p class="font-mono text-lg text-base-50">{{ outcome.activated }}</p>
                </li>
                <li class="rounded-lg border border-base-800 p-3">
                    <p class="text-xs text-base-500">Disuspen</p>
                    <p class="font-mono text-lg text-base-50">{{ outcome.suspended }}</p>
                </li>
                <li class="rounded-lg border border-base-800 p-3">
                    <p class="text-xs text-base-500">Site diatur</p>
                    <p class="font-mono text-lg text-base-50">{{ outcome.site_changed }}</p>
                </li>
            </ul>
            <p v-if="outcome.live_errors" class="text-xs text-warning-400">
                {{ outcome.live_errors }} staf yang disuspen belum berhasil dikeluarkan dari Live Kerja; sesi login mereka tetap dicabut.
            </p>
            <div v-if="outcome.skipped.length" class="rounded-lg border border-base-800 bg-base-900/60">
                <p class="border-b border-base-800 px-3 py-2 text-xs font-semibold text-base-300">
                    Dilewati ({{ outcome.skipped.length }})
                </p>
                <ul class="max-h-48 divide-y divide-base-800/70 overflow-y-auto">
                    <li v-for="item in outcome.skipped" :key="item.id" class="px-3 py-2 text-xs">
                        <span class="text-base-100">{{ item.name ?? `#${item.id}` }}</span>
                        <span class="text-base-500"> — {{ item.reason }}</span>
                    </li>
                </ul>
            </div>
        </div>

        <form v-else id="bulk-update-form" class="space-y-5" @submit.prevent="submit">
            <section>
                <p class="field-label">Staf yang diupdate ({{ selected.length }})</p>
                <label class="relative block">
                    <span class="sr-only">Cari email atau nama staf</span>
                    <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                    <input
                        v-model="search"
                        type="search"
                        maxlength="100"
                        placeholder="Cari email atau nama lalu klik untuk memilih…"
                        class="field-control pl-9"
                    />
                </label>
                <div v-if="search.trim()" class="mt-2 rounded-lg border border-base-800 bg-base-900/60">
                    <p v-if="searching" class="px-3 py-2 text-xs text-base-500">Mencari…</p>
                    <p v-else-if="results.length === 0" class="px-3 py-2 text-xs text-base-500">Tidak ada staf yang cocok.</p>
                    <ul v-else class="divide-y divide-base-800/70">
                        <li v-for="user in results" :key="user.id">
                            <label class="flex cursor-pointer items-center gap-2.5 px-3 py-2">
                                <input
                                    type="checkbox"
                                    class="size-4 accent-copper-500"
                                    :checked="isPicked(user)"
                                    @change="toggle(user)"
                                />
                                <span class="min-w-0">
                                    <span class="block truncate text-sm text-base-100">{{ user.email }}</span>
                                    <span class="block truncate text-xs text-base-500">{{ user.name }}</span>
                                </span>
                            </label>
                        </li>
                        <li class="px-3 py-1.5">
                            <button type="button" class="text-xs font-semibold text-accent-500 hover:underline" @click="addAllResults">
                                Pilih semua hasil ini
                            </button>
                        </li>
                    </ul>
                </div>
                <ul v-if="selected.length" class="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                    <li
                        v-for="user in selected"
                        :key="user.id"
                        class="flex items-center gap-1 rounded-full bg-base-800 py-1 pr-1 pl-2.5 text-xs text-base-100"
                    >
                        <span class="max-w-56 truncate">{{ user.email }}</span>
                        <button
                            type="button"
                            class="rounded-full p-0.5 text-base-400 hover:bg-base-700 hover:text-base-50"
                            :aria-label="`Hapus ${user.email} dari pilihan`"
                            @click="toggle(user)"
                        >
                            <X class="size-3" />
                        </button>
                    </li>
                </ul>
                <p v-else class="mt-2 text-xs text-base-500">Belum ada staf dipilih. Cari email di atas, atau centang di tabel sebelum membuka ini.</p>
                <p v-if="selected.length > MAX_USERS" class="mt-1 text-xs text-danger-400">
                    Paling banyak {{ MAX_USERS }} staf sekali proses.
                </p>
            </section>

            <BaseSelect v-model="role" label="Peran" hint="Menggantikan peran lama staf yang dipilih.">
                <option value="">Tidak diubah</option>
                <option v-for="item in roles" :key="item.name" :value="item.name">{{ item.label }}</option>
            </BaseSelect>

            <BaseSelect
                v-model="status"
                label="Status"
                :hint="status === 'suspended' ? 'Staf langsung keluar dari semua perangkat dan Live Kerja, dan tidak bisa login sampai diaktifkan lagi.' : null"
            >
                <option value="">Tidak diubah</option>
                <option value="active">Aktifkan semua</option>
                <option value="suspended">Suspen semua</option>
            </BaseSelect>

            <section class="space-y-3">
                <BaseSelect
                    v-model="siteMode"
                    label="Akses site"
                    hint="Hanya berlaku untuk peran yang melihat 'site yang diberikan' (mis. Admin, Leader); staf lain dilewati dan dilaporkan."
                >
                    <option v-for="mode in SITE_MODES" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
                </BaseSelect>
                <template v-if="siteMode">
                    <label class="flex items-start gap-2 text-sm text-base-100">
                        <input v-model="allSites" type="checkbox" class="mt-0.5 size-4 accent-copper-500" />
                        Semua site (termasuk site yang dibuat nanti tidak otomatis ikut)
                    </label>
                    <SitePicker v-model="sites" :sites="organizations" label="Pilih site" :disabled="allSites" />
                </template>
            </section>

            <p v-if="summary" class="rounded-lg border border-base-700 bg-base-850 p-3 text-xs text-base-300">
                {{ selected.length }} staf: {{ summary }}
            </p>
        </form>

        <template #footer>
            <BaseButton variant="ghost" @click="emit('update:open', false)">{{ outcome ? 'Tutup' : 'Batal' }}</BaseButton>
            <BaseButton
                v-if="!outcome"
                type="submit"
                form="bulk-update-form"
                :variant="status === 'suspended' ? 'danger' : 'primary'"
                :disabled="!canSubmit"
                :loading="submitting"
            >
                Terapkan ke {{ selected.length }} staf
            </BaseButton>
        </template>
    </BaseDialog>
</template>
