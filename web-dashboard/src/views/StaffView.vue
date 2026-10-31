<script setup>
import { Ban, CheckCircle2, ChevronDown, KeyRound, Pencil, Search, ShieldOff, Trash2, UserCog, Users } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BasePagination from '@/components/ui/BasePagination.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BulkUpdateDialog from '@/components/staff/BulkUpdateDialog.vue'
import SitePicker from '@/components/staff/SitePicker.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const toast = useToast()
const auth = useAuthStore()
// Root mengelola semua akun; admin & leader hanya bisa menonaktifkan /
// mengaktifkan kembali staf di site yang dipegangnya (dibatasi server).
const canManageAll = computed(() => auth.isSuperAdmin)

const staff = ref([])
const organizations = ref([])
const loading = ref(true)
const dialogOpen = ref(false)
const submitting = ref(false)
const editTarget = ref(null)
const passwordTarget = ref(null)
const passwordDialogOpen = ref(false)
const newPassword = ref('')
const changingPassword = ref(false)
const suspendTarget = ref(null)
const suspending = ref(false)
const resetTwoFactorTarget = ref(null)
const resettingTwoFactor = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)

// Daftar peran datang dari server (menu Peran): peran buatan sendiri ikut muncul di sini.
// Peran bawaan dipakai sebagai cadangan sampai daftarnya termuat.
const FALLBACK_ROLES = [
    { name: 'super_admin', label: 'Super Admin', description: 'Full akses semua fitur & semua site', site_scope: 'all' },
    { name: 'admin', label: 'Admin', description: 'Lihat site yang diizinkan', site_scope: 'granted' },
    { name: 'leader', label: 'Leader', description: 'Lihat site yang diizinkan', site_scope: 'granted' },
    { name: 'site_admin', label: 'Site Admin', description: 'Kelola site sendiri penuh', site_scope: 'own' },
    { name: 'staff_viewer', label: 'Staff Viewer', description: 'Lihat site sendiri', site_scope: 'own' },
]
const roleOptions = ref(FALLBACK_ROLES)

const ROLE_LABELS = computed(() => Object.fromEntries(roleOptions.value.map((role) => [role.name, role.label])))
const roleDescriptions = computed(() =>
    Object.fromEntries(roleOptions.value.map((role) => [role.name, role.description ? `${role.label} (${role.description})` : role.label])),
)
const scopeOfRole = (name) => roleOptions.value.find((role) => role.name === name)?.site_scope ?? 'own'

async function loadRoleOptions() {
    if (!canManageAll.value) return
    try {
        const response = await api.get('/roles/options')
        roleOptions.value = response.data.data
    } catch {
        // Cadangan bawaan tetap dipakai; daftar peran tidak menghalangi halaman Staf.
    }
}

const form = ref({
    name: '',
    username: '',
    email: '',
    password: '',
    role: 'admin',
    organization_id: null,
    site_access: [],
})

const needsSiteAccess = computed(() => scopeOfRole(form.value.role) === 'granted')

function resetForm() {
    form.value = { name: '', username: '', email: '', password: '', role: 'admin', organization_id: null, site_access: [] }
}

function openEdit(user) {
    editTarget.value = user
    form.value = {
        name: user.name,
        username: user.username,
        email: user.email,
        password: '',
        role: user.role,
        organization_id: user.organization_id ?? null,
        site_access: (user.site_access ?? []).map((s) => s.id),
    }
    dialogOpen.value = true
}

function openPasswordDialog(user) {
    passwordTarget.value = user
    newPassword.value = ''
    passwordDialogOpen.value = true
}

async function submitPassword() {
    changingPassword.value = true
    try {
        await api.put(`/users/${passwordTarget.value.id}`, { password: newPassword.value })
        toast.success(`Password ${passwordTarget.value.name} berhasil diganti`)
        passwordDialogOpen.value = false
    } catch (err) {
        toast.error('Gagal mengganti password', err.response?.data?.message)
    } finally {
        changingPassword.value = false
    }
}

// Daftar dimuat per halaman (10) dengan pencarian & filter di server, bukan seluruh staf sekaligus.
const PER_PAGE = 10
const SEARCH_DEBOUNCE_MS = 350

const page = ref(1)
const total = ref(0)
const lastPage = ref(1)
const counts = ref({ active: 0, suspended: 0 })
const search = ref('')
const statusFilter = ref('')
const roleFilter = ref('')
const refreshing = ref(false)
let loadSeq = 0
let searchTimer = null

const hasFilters = computed(() => Boolean(search.value.trim() || statusFilter.value || roleFilter.value))

async function loadStaff() {
    // Hanya jawaban permintaan terbaru yang dipakai (ketikan cepat tidak menimpa hasil baru).
    const seq = ++loadSeq
    refreshing.value = true
    try {
        const response = await api.get('/users', {
            params: {
                per_page: PER_PAGE,
                page: page.value,
                search: search.value.trim() || undefined,
                status: statusFilter.value || undefined,
                role: roleFilter.value || undefined,
            },
        })
        if (seq !== loadSeq) return
        const data = response.data.data
        // Halaman ini sudah kosong (mis. baris terakhirnya dihapus): mundur ke halaman terakhir.
        if (data.items.length === 0 && page.value > 1 && data.total > 0) {
            page.value = Math.max(Math.ceil(data.total / PER_PAGE), 1)
            return loadStaff()
        }
        staff.value = data.items
        total.value = data.total
        lastPage.value = data.last_page ?? 1
        counts.value = { active: data.active_count ?? 0, suspended: data.suspended_count ?? 0 }
    } catch (err) {
        if (seq === loadSeq) toast.error('Gagal memuat daftar staf', err.response?.data?.message)
    } finally {
        if (seq === loadSeq) {
            loading.value = false
            refreshing.value = false
        }
    }
}

function goToPage(next) {
    page.value = next
    loadStaff()
}

// ---- Pilih banyak staf & atur site massal -------------------------------------------------
// Pilihan staf untuk Update massal (centang di tabel; bertahan saat pindah halaman atau mengganti filter).
// Dialog Update juga bisa mencari email sendiri, jadi centang di sini hanya jalan pintas.
const selectedUsers = ref([])
const selectedIds = computed(() => selectedUsers.value.map((user) => user.id))
const updateOpen = ref(false)

const pick = (user) => ({ id: user.id, name: user.name, email: user.email })
const isSelectable = () => true
const selectableOnPage = computed(() => staff.value)
const allOnPageSelected = computed(
    () => selectableOnPage.value.length > 0 && selectableOnPage.value.every((user) => selectedIds.value.includes(user.id)),
)
const someOnPageSelected = computed(
    () => !allOnPageSelected.value && selectableOnPage.value.some((user) => selectedIds.value.includes(user.id)),
)

function toggleSelected(user) {
    selectedUsers.value = selectedIds.value.includes(user.id)
        ? selectedUsers.value.filter((item) => item.id !== user.id)
        : [...selectedUsers.value, pick(user)]
}

function togglePageSelection() {
    const pageIds = selectableOnPage.value.map((user) => user.id)
    selectedUsers.value = allOnPageSelected.value
        ? selectedUsers.value.filter((item) => !pageIds.includes(item.id))
        : [...selectedUsers.value, ...selectableOnPage.value.filter((user) => !selectedIds.value.includes(user.id)).map(pick)]
}

const clearSelection = () => (selectedUsers.value = [])

async function onUpdateDone() {
    clearSelection()
    await loadStaff()
}

/** Ringkasan kolom "Akses site": banyak site (mis. auditor) tidak membanjiri baris tabel. */
function siteSummary(user) {
    if (scopeOfRole(user.role) === 'all') return { text: 'Semua site', title: null }
    const sites = user.site_access ?? []
    if (sites.length > 0) {
        const names = sites.map((site) => site.name)
        if (names.length <= 2) return { text: names.join(', '), title: null }
        return { text: `${names.length} site`, title: names.join(', ') }
    }
    const own = organizations.value.find((org) => org.id === user.organization_id)?.name
    return { text: own ?? '—', title: null }
}

function resetFilters() {
    search.value = ''
    statusFilter.value = ''
    roleFilter.value = ''
}

watch(search, () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
        page.value = 1
        loadStaff()
    }, SEARCH_DEBOUNCE_MS)
})
watch([statusFilter, roleFilter], () => {
    page.value = 1
    loadStaff()
})
onBeforeUnmount(() => clearTimeout(searchTimer))

async function loadOrganizations() {
    if (!canManageAll.value) {
        const response = await api.get('/live/sites')
        organizations.value = response.data.data
        return
    }
    const response = await api.get('/organizations', { params: { per_page: 200 } })
    organizations.value = response.data.data.items
}

async function submitForm() {
    submitting.value = true
    try {
        if (editTarget.value) {
            await api.put(`/users/${editTarget.value.id}`, {
                name: form.value.name,
                email: form.value.email,
                role: form.value.role,
                organization_id: needsSiteAccess.value ? null : form.value.organization_id,
            })
            if (needsSiteAccess.value) {
                await api.put(`/users/${editTarget.value.id}/site-access`, { organization_ids: form.value.site_access })
            }
            toast.success('Staf berhasil diperbarui')
        } else {
            await api.post('/users', form.value)
            toast.success('Staf berhasil dibuat')
        }
        dialogOpen.value = false
        editTarget.value = null
        resetForm()
        await loadStaff()
    } catch (err) {
        toast.error(editTarget.value ? 'Gagal memperbarui staf' : 'Gagal membuat staf', err.response?.data?.message)
    } finally {
        submitting.value = false
    }
}

async function confirmSuspend() {
    const user = suspendTarget.value
    suspending.value = true
    try {
        await api.post(`/users/${user.id}/suspend`)
        toast.success(`${user.name} disuspen`)
        suspendTarget.value = null
        await loadStaff()
    } catch (err) {
        toast.error('Gagal men-suspend', err.response?.data?.message)
    } finally {
        suspending.value = false
    }
}

async function reactivate(user) {
    try {
        await api.post(`/users/${user.id}/reactivate`)
        toast.success(`${user.name} diaktifkan kembali`)
        await loadStaff()
    } catch (err) {
        toast.error('Gagal mengaktifkan', err.response?.data?.message)
    }
}

async function confirmResetTwoFactor() {
    const user = resetTwoFactorTarget.value
    resettingTwoFactor.value = true
    try {
        await api.post(`/users/${user.id}/reset-2fa`)
        toast.success(`2FA ${user.name} berhasil direset`)
        resetTwoFactorTarget.value = null
        await loadStaff()
    } catch (err) {
        toast.error('Gagal reset 2FA', err.response?.data?.message)
    } finally {
        resettingTwoFactor.value = false
    }
}

async function confirmDelete() {
    const user = deleteTarget.value
    deleting.value = true
    try {
        await api.delete(`/users/${user.id}`)
        toast.success(`${user.name} dihapus`)
        deleteTarget.value = null
        await loadStaff()
    } catch (err) {
        toast.error('Gagal menghapus', err.response?.data?.message)
    } finally {
        deleting.value = false
    }
}

function menuItems(user) {
    if (!canManageAll.value) {
        return [
            { label: 'Nonaktifkan akun', icon: Ban, onSelect: () => (suspendTarget.value = user), hidden: !user.is_active },
            { label: 'Aktifkan kembali', icon: CheckCircle2, onSelect: () => reactivate(user), hidden: user.is_active },
        ]
    }
    return [
        { label: 'Ganti password', icon: KeyRound, onSelect: () => openPasswordDialog(user) },
        { label: 'Reset 2FA', icon: ShieldOff, onSelect: () => (resetTwoFactorTarget.value = user) },
        { label: 'Suspen akun', icon: Ban, onSelect: () => (suspendTarget.value = user), hidden: !user.is_active },
        { label: 'Aktifkan kembali', icon: CheckCircle2, onSelect: () => reactivate(user), hidden: user.is_active },
        { label: 'Hapus staf', icon: Trash2, onSelect: () => (deleteTarget.value = user), danger: true },
    ]
}

onMounted(async () => {
    await Promise.all([loadStaff(), loadOrganizations(), loadRoleOptions()])
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Akses"
            title="Staf"
            :subtitle="
                canManageAll
                    ? 'Siapa yang bisa masuk ke dashboard dan aplikasi SMB Admin, dengan peran dan site masing-masing.'
                    : 'Staf di site Anda. Staf yang dinonaktifkan langsung keluar dari semua perangkat dan harus login ulang setelah diaktifkan kembali.'
            "
        >
            <template v-if="canManageAll" #actions>
                <BaseButton @click="updateOpen = true"><UserCog class="size-4" /> Update staf</BaseButton>
            </template>
            <template v-if="!loading" #readouts>
                <Readout label="Total" :value="counts.active + counts.suspended" />
                <Readout label="Aktif" :value="counts.active" led="accent" />
                <Readout label="Disuspen" :value="counts.suspended" :led="counts.suspended ? 'danger' : 'muted'" />
            </template>
        </PageHeader>

        <div class="p-4 sm:p-8">
            <BaseCard title="Semua staf" :count="loading ? null : total" flush>
                <div class="flex flex-wrap items-center gap-2 border-b border-base-800 px-5 py-3">
                    <label class="relative min-w-52 flex-1">
                        <span class="sr-only">Cari staf</span>
                        <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                        <input
                            v-model="search"
                            type="search"
                            maxlength="100"
                            placeholder="Cari nama, username, atau email…"
                            class="field-control h-9 pl-9 text-sm"
                        />
                    </label>
                    <label class="relative">
                        <span class="sr-only">Filter peran</span>
                        <select v-model="roleFilter" class="field-control h-9 appearance-none pr-8 text-sm">
                            <option value="">Semua peran</option>
                            <option v-for="role in roleOptions" :key="role.name" :value="role.name">{{ role.label }}</option>
                        </select>
                        <ChevronDown class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-base-500" />
                    </label>
                    <label class="relative">
                        <span class="sr-only">Filter status</span>
                        <select v-model="statusFilter" class="field-control h-9 appearance-none pr-8 text-sm">
                            <option value="">Semua status</option>
                            <option value="active">Aktif</option>
                            <option value="suspended">Disuspen</option>
                        </select>
                        <ChevronDown class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-base-500" />
                    </label>
                </div>

                <div
                    v-if="canManageAll && selectedIds.length > 0"
                    class="flex flex-wrap items-center justify-between gap-2 border-b border-accent-500/30 bg-accent-500/10 px-5 py-2.5"
                >
                    <p class="text-sm text-base-100">
                        <span class="font-mono font-semibold">{{ selectedIds.length }}</span> staf dipilih
                    </p>
                    <div class="flex items-center gap-2">
                        <BaseButton size="sm" variant="ghost" @click="clearSelection">Batal pilih</BaseButton>
                        <BaseButton size="sm" @click="updateOpen = true"><UserCog class="size-3.5" /> Update terpilih</BaseButton>
                    </div>
                </div>
                <p v-else-if="canManageAll && !loading && staff.some(isSelectable)" class="border-b border-base-800 px-5 py-2 text-xs text-base-500">
                    Centang beberapa staf lalu pilih Update untuk mengganti peran, status, dan site mereka sekaligus.
                </p>

                <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat daftar staf…</div>
                <EmptyState
                    v-else-if="staff.length === 0 && hasFilters"
                    :icon="Search"
                    title="Tidak ada staf yang cocok"
                    description="Coba kata kunci lain atau hapus filter."
                >
                    <BaseButton variant="outline" @click="resetFilters">Hapus filter</BaseButton>
                </EmptyState>
                <EmptyState
                    v-else-if="staff.length === 0"
                    :icon="Users"
                    title="Belum ada staf"
                    description="Staf muncul otomatis setelah login lewat Account Center (belum aktif), lalu diaktifkan lewat Update staf."
                />
                <div v-else class="overflow-x-auto transition-opacity" :class="refreshing && 'opacity-60'">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th v-if="canManageAll" class="w-0">
                                    <input
                                        type="checkbox"
                                        class="size-4 accent-accent-500"
                                        aria-label="Pilih semua staf di halaman ini"
                                        :checked="allOnPageSelected"
                                        :indeterminate="someOnPageSelected"
                                        :disabled="selectableOnPage.length === 0"
                                        @change="togglePageSelection"
                                    />
                                </th>
                                <th>Staf</th>
                                <th class="hidden sm:table-cell">Peran</th>
                                <th class="hidden md:table-cell">Akses site</th>
                                <th class="hidden sm:table-cell">Status</th>
                                <th class="w-0"><span class="sr-only">Aksi</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="user in staff" :key="user.id">
                                <td v-if="canManageAll">
                                    <input
                                        v-if="isSelectable(user)"
                                        type="checkbox"
                                        class="size-4 accent-accent-500"
                                        :aria-label="`Pilih ${user.name}`"
                                        :checked="selectedIds.includes(user.id)"
                                        @change="toggleSelected(user)"
                                    />
                                </td>
                                <td>
                                    <div class="flex items-center gap-3">
                                        <span
                                            class="flex size-9 shrink-0 items-center justify-center rounded-md bg-base-800 font-mono text-sm text-base-200"
                                        >
                                            {{ user.name?.charAt(0)?.toUpperCase() }}
                                        </span>
                                        <div class="min-w-0">
                                            <p class="truncate font-medium text-base-50">{{ user.name }}</p>
                                            <p class="truncate font-mono text-xs text-base-500">{{ user.username }} · {{ user.email }}</p>
                                            <p class="mt-1 text-xs text-base-400 sm:hidden">
                                                {{ ROLE_LABELS[user.role] ?? user.role }} · {{ user.is_active ? 'Aktif' : 'Disuspen' }}
                                            </p>
                                        </div>
                                    </div>
                                </td>
                                <td class="hidden sm:table-cell">
                                    <BaseBadge variant="accent">{{ ROLE_LABELS[user.role] ?? user.role }}</BaseBadge>
                                </td>
                                <td class="hidden text-xs text-base-400 md:table-cell">
                                    <span :title="siteSummary(user).title ?? undefined">{{ siteSummary(user).text }}</span>
                                </td>
                                <td class="hidden sm:table-cell">
                                    <StatusDot
                                        :status="user.is_active ? 'active' : 'inactive'"
                                        :label="user.is_active ? 'Aktif' : 'Disuspen'"
                                    />
                                </td>
                                <td>
                                    <div class="flex items-center justify-end gap-1">
                                        <BaseButton v-if="canManageAll" size="sm" variant="outline" @click="openEdit(user)"
                                            ><Pencil class="size-3.5" /> <span class="max-sm:sr-only">Ubah</span></BaseButton
                                        >
                                        <RowMenu :items="menuItems(user)" :label="`Aksi lain untuk ${user.name}`" />
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <BasePagination
                    v-if="!loading"
                    :page="page"
                    :last-page="lastPage"
                    :total="total"
                    :per-page="PER_PAGE"
                    :disabled="refreshing"
                    @update:page="goToPage"
                />
            </BaseCard>
        </div>

        <BaseDialog
            :open="dialogOpen"
            :title="editTarget ? `Ubah staf ${editTarget.name}` : 'Tambah staf'"
            :description="
                editTarget ? 'Peran dan akses site berlaku di login berikutnya.' : 'Staf baru wajib memasang 2FA saat pertama kali masuk.'
            "
            @update:open="
                (v) => {
                    dialogOpen = v
                    if (!v) editTarget = null
                }
            "
        >
            <form id="staff-form" class="space-y-4" @submit.prevent="submitForm">
                <BaseInput v-model="form.name" label="Nama" required />
                <BaseInput
                    :model-value="form.username"
                    label="Username"
                    required
                    autocapitalize="none"
                    autocorrect="off"
                    spellcheck="false"
                    :disabled="!!editTarget"
                    :hint="editTarget ? 'Username tidak bisa diubah setelah dibuat.' : 'Otomatis huruf kecil.'"
                    @update:model-value="(value) => (form.username = value.toLowerCase())"
                />
                <BaseInput v-model="form.email" label="Email" type="email" required hint="Juga dipakai untuk masuk lewat Account Center." />
                <BaseInput
                    v-if="!editTarget"
                    v-model="form.password"
                    label="Password awal"
                    type="password"
                    required
                    minlength="8"
                    autocomplete="new-password"
                    hint="Minimal 8 karakter."
                />

                <BaseSelect v-model="form.role" label="Peran">
                    <option v-for="role in roleOptions" :key="role.name" :value="role.name">{{ roleDescriptions[role.name] }}</option>
                </BaseSelect>

                <p v-if="scopeOfRole(form.role) === 'all'" class="rounded-lg border border-base-700 bg-base-850 p-3 text-xs text-base-300">
                    Peran ini melihat semua site, jadi tidak perlu memilih site.
                </p>

                <BaseSelect v-else-if="!needsSiteAccess" v-model="form.organization_id" label="Site" required>
                    <option :value="null" disabled>Pilih site</option>
                    <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                </BaseSelect>

                <SitePicker v-else v-model="form.site_access" :sites="organizations" label="Site yang boleh dilihat" />
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="staff-form" :loading="submitting">{{
                    editTarget ? 'Simpan perubahan' : 'Buat staf'
                }}</BaseButton>
            </template>
        </BaseDialog>

        <BulkUpdateDialog
            v-model:open="updateOpen"
            :preselected="selectedUsers"
            :roles="roleOptions"
            :organizations="organizations"
            @done="onUpdateDone"
        />

        <BaseDialog
            :open="passwordDialogOpen"
            :title="`Ganti password ${passwordTarget?.name ?? ''}`"
            description="Password baru langsung berlaku. Sampaikan ke staf yang bersangkutan secara langsung."
            size="sm"
            @update:open="(v) => (passwordDialogOpen = v)"
        >
            <form id="password-form" @submit.prevent="submitPassword">
                <BaseInput
                    v-model="newPassword"
                    label="Password baru"
                    type="password"
                    required
                    minlength="8"
                    autocomplete="new-password"
                    hint="Minimal 8 karakter."
                />
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="passwordDialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="password-form" :loading="changingPassword">Ganti password</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!suspendTarget"
            :title="suspendTarget ? `Suspen ${suspendTarget.name}?` : ''"
            description="Staf langsung keluar dari dashboard, aplikasi HP, dan Live Kerja di semua perangkat (dalam ±10 detik), dan tidak bisa login sampai diaktifkan kembali."
            confirm-label="Suspen"
            :loading="suspending"
            @update:open="(v) => !v && (suspendTarget = null)"
            @confirm="confirmSuspend"
        />

        <ConfirmDialog
            :open="!!resetTwoFactorTarget"
            :title="resetTwoFactorTarget ? `Reset 2FA ${resetTwoFactorTarget.name}?` : ''"
            description="Sesi yang sedang aktif dicabut, dan login berikutnya wajib memasang authenticator dari awal."
            confirm-label="Reset 2FA"
            :loading="resettingTwoFactor"
            @update:open="(v) => !v && (resetTwoFactorTarget = null)"
            @confirm="confirmResetTwoFactor"
        />

        <ConfirmDialog
            :open="!!deleteTarget"
            :title="deleteTarget ? `Hapus ${deleteTarget.name}?` : ''"
            description="Akun ini dihapus permanen dan tidak bisa dipulihkan."
            confirm-label="Hapus staf"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />
    </div>
</template>
