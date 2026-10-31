<script setup>
import { Building2, ChevronDown, Copy, Pencil, Plus, Search, Trash2 } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BasePagination from '@/components/ui/BasePagination.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

const organizations = ref([])
const loading = ref(true)
const dialogOpen = ref(false)
const submitting = ref(false)
const toast = useToast()

const form = ref({ name: '', type: 'company_asset' })
const editingOrg = ref(null)
const deleteTarget = ref(null)
const deleting = ref(false)
const deleteTitle = computed(() => (deleteTarget.value ? `Hapus site "${deleteTarget.value.name}"?` : ''))

// Daftar dimuat per halaman dengan pencarian & filter di server. 12 per halaman = pas untuk
// kisi 2, 3, dan 4 kolom (tanpa kartu yatim di baris terakhir).
const PER_PAGE = 12
const SEARCH_DEBOUNCE_MS = 350

const page = ref(1)
const total = ref(0)
const lastPage = ref(1)
const counts = ref({ active: 0, inactive: 0, devices: 0 })
const search = ref('')
const statusFilter = ref('')
const refreshing = ref(false)
let loadSeq = 0
let searchTimer = null

const hasFilters = computed(() => Boolean(search.value.trim() || statusFilter.value))

async function loadOrganizations() {
    // Hanya jawaban permintaan terbaru yang dipakai (ketikan cepat tidak menimpa hasil baru).
    const seq = ++loadSeq
    refreshing.value = true
    try {
        const response = await api.get('/organizations', {
            params: {
                per_page: PER_PAGE,
                page: page.value,
                search: search.value.trim() || undefined,
                status: statusFilter.value || undefined,
            },
        })
        if (seq !== loadSeq) return
        const data = response.data.data
        // Halaman ini sudah kosong (mis. site terakhirnya dihapus): mundur ke halaman terakhir.
        if (data.items.length === 0 && page.value > 1 && data.total > 0) {
            page.value = Math.max(Math.ceil(data.total / PER_PAGE), 1)
            return loadOrganizations()
        }
        organizations.value = data.items
        total.value = data.total
        lastPage.value = data.last_page ?? 1
        counts.value = {
            active: data.active_count ?? 0,
            inactive: data.inactive_count ?? 0,
            devices: data.devices_total ?? 0,
        }
    } catch (err) {
        if (seq === loadSeq) toast.error('Gagal memuat daftar site', err.response?.data?.message)
    } finally {
        if (seq === loadSeq) {
            loading.value = false
            refreshing.value = false
        }
    }
}

function goToPage(next) {
    page.value = next
    loadOrganizations()
}

function resetFilters() {
    search.value = ''
    statusFilter.value = ''
}

watch(search, () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
        page.value = 1
        loadOrganizations()
    }, SEARCH_DEBOUNCE_MS)
})
watch(statusFilter, () => {
    page.value = 1
    loadOrganizations()
})
onBeforeUnmount(() => clearTimeout(searchTimer))

async function submitForm() {
    submitting.value = true
    try {
        if (editingOrg.value) {
            await api.put(`/organizations/${editingOrg.value.id}`, form.value)
            toast.success('Nama site diubah')
        } else {
            await api.post('/organizations', form.value)
            toast.success('Site berhasil dibuat')
        }
        dialogOpen.value = false
        form.value = { name: '', type: 'company_asset' }
        editingOrg.value = null
        await loadOrganizations()
    } catch (err) {
        // Kesalahan isian (mis. nama site sudah dipakai) ditampilkan apa adanya, bukan pesan umum.
        const detail = err.response?.data?.errors?.name?.[0] ?? err.response?.data?.message
        toast.error(editingOrg.value ? 'Gagal mengubah site' : 'Gagal membuat site', detail)
    } finally {
        submitting.value = false
    }
}

function openEdit(org) {
    editingOrg.value = org
    form.value = { name: org.name, type: org.type ?? 'company_asset' }
    dialogOpen.value = true
}

async function confirmDelete() {
    deleting.value = true
    try {
        await api.delete(`/organizations/${deleteTarget.value.id}`)
        toast.success('Site dihapus')
        deleteTarget.value = null
        await loadOrganizations()
    } catch (err) {
        toast.error('Gagal menghapus site', err.response?.data?.message)
    } finally {
        deleting.value = false
    }
}

function copySiteCode(code) {
    navigator.clipboard.writeText(code)
    toast.info('Kode site disalin', code)
}

function openCreate() {
    editingOrg.value = null
    form.value = { name: '', type: 'company_asset' }
    dialogOpen.value = true
}

function menuItems(org) {
    return [
        { label: 'Ubah nama', icon: Pencil, onSelect: () => openEdit(org) },
        { label: 'Hapus site', icon: Trash2, onSelect: () => (deleteTarget.value = org), danger: true },
    ]
}

onMounted(loadOrganizations)
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Akses"
            title="Site"
            subtitle="Setiap site punya kode unik yang ditanam ke APK pelacak miliknya. Data antar site tidak saling terlihat."
        >
            <template #actions>
                <BaseButton @click="openCreate"><Plus class="size-4" /> Tambah site</BaseButton>
            </template>
            <template v-if="!loading" #readouts>
                <Readout label="Site" :value="counts.active + counts.inactive" />
                <Readout label="Aktif" :value="counts.active" led="accent" />
                <Readout label="Device terdaftar" :value="counts.devices" />
            </template>
        </PageHeader>

        <div class="p-4 sm:p-8">
            <div class="mb-4 flex flex-wrap items-center gap-2">
                <label class="relative min-w-52 flex-1">
                    <span class="sr-only">Cari site</span>
                    <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                    <input
                        v-model="search"
                        type="search"
                        maxlength="100"
                        placeholder="Cari nama atau kode site…"
                        class="field-control h-9 pl-9 text-sm"
                    />
                </label>
                <BaseSelect v-model="statusFilter" variant="compact" aria-label="Filter status">
                        <option value="">Semua status</option>
                        <option value="active">Aktif</option>
                        <option value="inactive">Nonaktif</option>
                    </BaseSelect>
            </div>

            <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat site…</div>
            <div v-else-if="organizations.length === 0 && hasFilters" class="rounded-xl border border-base-800 bg-base-900/70">
                <EmptyState :icon="Search" title="Tidak ada site yang cocok" description="Coba kata kunci lain atau hapus filter.">
                    <BaseButton variant="outline" @click="resetFilters">Hapus filter</BaseButton>
                </EmptyState>
            </div>
            <div v-else-if="organizations.length === 0" class="rounded-xl border border-base-800 bg-base-900/70">
                <EmptyState
                    :icon="Building2"
                    title="Belum ada site"
                    description="Buat site pertama, lalu tambahkan staf dan build APK pelacak untuk site itu."
                >
                    <BaseButton @click="openCreate"><Plus class="size-4" /> Tambah site</BaseButton>
                </EmptyState>
            </div>
            <ul
                v-else
                class="grid grid-cols-1 gap-4 transition-opacity sm:grid-cols-2 xl:grid-cols-3"
                :class="refreshing && 'opacity-60'"
            >
                <li
                    v-for="org in organizations"
                    :key="org.id"
                    class="flex flex-col rounded-xl border border-base-800 bg-base-900/70 p-5 transition-colors hover:border-base-700"
                >
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <StatusDot :status="org.is_active ? 'active' : 'inactive'" />
                            <h2 class="mt-2 font-display text-lg leading-snug font-bold text-base-50 tracking-[-0.015em]">
                                {{ org.name }}
                            </h2>
                        </div>
                        <RowMenu :items="menuItems(org)" :label="`Aksi untuk ${org.name}`" />
                    </div>

                    <dl class="mt-5 grid grid-cols-2 gap-4 border-t border-base-800 pt-4">
                        <div>
                            <dt class="eyebrow">Device</dt>
                            <dd class="mt-1 font-mono text-xl text-base-50 tabular-nums">{{ org.devices_count ?? 0 }}</dd>
                        </div>
                        <div class="min-w-0">
                            <dt class="eyebrow">Kode site</dt>
                            <dd class="mt-1">
                                <button
                                    type="button"
                                    class="group inline-flex max-w-full items-center gap-1.5 rounded font-mono text-sm text-base-200 hover:text-accent-300 focus-visible:outline-2 focus-visible:outline-accent-400"
                                    :title="`Salin kode ${org.unique_site_code}`"
                                    @click="copySiteCode(org.unique_site_code)"
                                >
                                    <span class="truncate">{{ org.unique_site_code }}</span>
                                    <Copy class="size-3.5 shrink-0 text-base-500 group-hover:text-accent-300" />
                                </button>
                            </dd>
                        </div>
                    </dl>
                </li>
            </ul>
            <BasePagination
                v-if="!loading"
                class="mt-4 rounded-xl border"
                :page="page"
                :last-page="lastPage"
                :total="total"
                :per-page="PER_PAGE"
                :disabled="refreshing"
                @update:page="goToPage"
            />
        </div>

        <BaseDialog
            :open="dialogOpen"
            :title="editingOrg ? `Ubah nama ${editingOrg.name}` : 'Tambah site'"
            :description="
                editingOrg
                    ? 'Kode site tidak berubah, jadi APK yang sudah terpasang tetap terhubung.'
                    : 'Kode unik site dibuat otomatis dari namanya.'
            "
            size="sm"
            @update:open="
                (v) => {
                    dialogOpen = v
                    if (!v) editingOrg = null
                }
            "
        >
            <form id="site-form" @submit.prevent="submitForm">
                <BaseInput v-model="form.name" label="Nama site" placeholder="PT Contoh Logistik" required />
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="site-form" :loading="submitting">{{ editingOrg ? 'Simpan nama' : 'Buat site' }}</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!deleteTarget"
            :title="deleteTitle"
            description="Semua device milik site ini ikut terhapus."
            confirm-label="Hapus site"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />
    </div>
</template>
