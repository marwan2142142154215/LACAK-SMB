<script setup>
import { Ban, CheckCircle2, KeyRound, Pencil, Trash2, UserPlus } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, onMounted, ref } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

const toast = useToast()

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

const ROLE_LABELS = {
    super_admin: 'Super Admin',
    admin: 'Admin',
    leader: 'Leader',
    site_admin: 'Site Admin',
    staff_viewer: 'Staff Viewer',
}

const roleDescriptions = {
    super_admin: 'Super Admin (full akses semua fitur & semua site)',
    admin: 'Admin (lihat site yang diizinkan)',
    leader: 'Leader (lihat site yang diizinkan)',
    site_admin: 'Site Admin (kelola site sendiri penuh)',
    staff_viewer: 'Staff Viewer (lihat site sendiri)',
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

const needsSiteAccess = computed(() => form.value.role === 'admin' || form.value.role === 'leader')

function resetForm() {
    form.value = { name: '', username: '', email: '', password: '', role: 'admin', organization_id: null, site_access: [] }
}

function openCreate() {
    editTarget.value = null
    resetForm()
    dialogOpen.value = true
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

async function loadStaff() {
    loading.value = true
    try {
        const response = await api.get('/users', { params: { per_page: 100 } })
        staff.value = response.data.data.items
    } finally {
        loading.value = false
    }
}

async function loadOrganizations() {
    const response = await api.get('/organizations', { params: { per_page: 200 } })
    organizations.value = response.data.data.items
}

function toggleSiteAccess(orgId) {
    const idx = form.value.site_access.indexOf(orgId)
    if (idx === -1) form.value.site_access.push(orgId)
    else form.value.site_access.splice(idx, 1)
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

async function suspend(user) {
    try {
        await api.post(`/users/${user.id}/suspend`)
        toast.success(`${user.name} disuspen`)
        await loadStaff()
    } catch (err) {
        toast.error('Gagal men-suspend', err.response?.data?.message)
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

async function remove(user) {
    if (!confirm(`Hapus staf ${user.name}? Tindakan ini tidak bisa dibatalkan.`)) return
    try {
        await api.delete(`/users/${user.id}`)
        toast.success(`${user.name} dihapus`)
        await loadStaff()
    } catch (err) {
        toast.error('Gagal menghapus', err.response?.data?.message)
    }
}

onMounted(async () => {
    await Promise.all([loadStaff(), loadOrganizations()])
})
</script>

<template>
    <div>
        <PageHeader title="Staf" subtitle="Kelola siapa yang bisa login ke web dashboard & APK master">
            <template #actions>
                <BaseButton @click="openCreate"><UserPlus class="size-4" /> Tambah Staf</BaseButton>
            </template>
        </PageHeader>

        <div class="p-8">
            <BaseCard title="Semua Staf">
                <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat...</div>
                <div v-else-if="staff.length === 0" class="py-12 text-center text-sm text-base-500">Belum ada staf.</div>
                <div v-else class="space-y-3">
                    <div
                        v-for="user in staff"
                        :key="user.id"
                        class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-base-800 bg-base-850/60 p-4"
                    >
                        <div>
                            <div class="flex items-center gap-2">
                                <p class="font-medium text-base-100">{{ user.name }}</p>
                                <BaseBadge variant="accent">{{ ROLE_LABELS[user.role] ?? user.role }}</BaseBadge>
                                <BaseBadge :variant="user.is_active ? 'success' : 'danger'">
                                    {{ user.is_active ? 'Aktif' : 'Disuspen' }}
                                </BaseBadge>
                            </div>
                            <p class="mt-1 text-xs text-base-500">{{ user.username }} · {{ user.email }}</p>
                            <p v-if="user.site_access?.length" class="mt-1 text-[11px] text-base-600">
                                Akses site: {{ user.site_access.map((s) => s.name).join(', ') }}
                            </p>
                        </div>
                        <div class="flex items-center gap-2">
                            <button
                                type="button"
                                class="flex items-center gap-1.5 rounded-lg border border-base-700 px-3 py-2 text-xs text-base-300 hover:border-accent-500/50 hover:text-accent-300"
                                @click="openEdit(user)"
                            >
                                <Pencil class="size-3.5" /> Edit
                            </button>
                            <button
                                type="button"
                                class="flex items-center gap-1.5 rounded-lg border border-base-700 px-3 py-2 text-xs text-base-300 hover:border-copper-500/50 hover:text-copper-300"
                                @click="openPasswordDialog(user)"
                            >
                                <KeyRound class="size-3.5" /> Ganti Password
                            </button>
                            <button
                                v-if="user.is_active"
                                type="button"
                                class="flex items-center gap-1.5 rounded-lg border border-base-700 px-3 py-2 text-xs text-base-300 hover:border-warning-500/50 hover:text-warning-300"
                                @click="suspend(user)"
                            >
                                <Ban class="size-3.5" /> Suspen
                            </button>
                            <button
                                v-else
                                type="button"
                                class="flex items-center gap-1.5 rounded-lg border border-base-700 px-3 py-2 text-xs text-base-300 hover:border-accent-500/50 hover:text-accent-300"
                                @click="reactivate(user)"
                            >
                                <CheckCircle2 class="size-3.5" /> Aktifkan
                            </button>
                            <button
                                type="button"
                                class="flex items-center gap-1.5 rounded-lg border border-base-700 px-3 py-2 text-xs text-base-300 hover:border-danger-500/50 hover:text-danger-300"
                                @click="remove(user)"
                            >
                                <Trash2 class="size-3.5" /> Hapus
                            </button>
                        </div>
                    </div>
                </div>
            </BaseCard>
        </div>

        <DialogRoot :open="dialogOpen" @update:open="(v) => { dialogOpen = v; if (!v) editTarget = null }">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-full max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl"
                >
                    <DialogTitle class="text-base font-semibold text-base-50">{{ editTarget ? `Ubah Staf: ${editTarget.name}` : 'Tambah Staf Baru' }}</DialogTitle>
                    <DialogDescription class="sr-only">Formulir untuk mengubah atau menambah staf</DialogDescription>
                    <form class="mt-5 space-y-4" @submit.prevent="submitForm">
                        <BaseInput v-model="form.name" label="Nama" required />
                        <BaseInput v-model="form.username" label="Username" required :disabled="!!editTarget" />
                        <p v-if="editTarget" class="-mt-2.5 text-[11px] text-base-600">Username tidak bisa diubah setelah dibuat.</p>
                        <BaseInput v-model="form.email" label="Email" type="email" required />
                        <BaseInput v-if="!editTarget" v-model="form.password" label="Password" type="password" required minlength="8" />

                        <label class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Peran</span>
                            <select
                                v-model="form.role"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option v-for="(desc, role) in roleDescriptions" :key="role" :value="role">{{ desc }}</option>
                            </select>
                        </label>

                        <p v-if="form.role === 'super_admin'" class="rounded-lg border border-base-700 bg-base-850 p-3 text-xs text-base-300">
                            Super Admin punya full akses semua fitur & semua site — tidak perlu memilih site.
                        </p>

                        <label v-else-if="!needsSiteAccess" class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Site</span>
                            <select
                                v-model="form.organization_id"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option :value="null" disabled>Pilih site</option>
                                <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                            </select>
                        </label>

                        <div v-else class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Site yang diizinkan dilihat</span>
                            <div class="max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-base-700 p-3">
                                <label v-for="org in organizations" :key="org.id" class="flex items-center gap-2 text-sm text-base-200">
                                    <input
                                        type="checkbox"
                                        :checked="form.site_access.includes(org.id)"
                                        class="rounded border-base-600"
                                        @change="toggleSiteAccess(org.id)"
                                    />
                                    {{ org.name }}
                                </label>
                            </div>
                        </div>

                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                            <BaseButton type="submit" :loading="submitting">{{ editTarget ? 'Simpan Perubahan' : 'Buat Staf' }}</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <DialogRoot :open="passwordDialogOpen" @update:open="(v) => (passwordDialogOpen = v)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl"
                >
                    <DialogTitle class="text-base font-semibold text-base-50">Ganti Password: {{ passwordTarget?.name }}</DialogTitle>
                    <DialogDescription class="mt-2 text-sm text-base-400">
                        Password baru berlaku langsung — semua sesi login akun ini sebaiknya diberi tahu.
                    </DialogDescription>
                    <form class="mt-5 space-y-4" @submit.prevent="submitPassword">
                        <BaseInput v-model="newPassword" label="Password Baru" type="password" required minlength="8" autocomplete="new-password" />
                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="passwordDialogOpen = false">Batal</BaseButton>
                            <BaseButton type="submit" :loading="changingPassword">Ganti Password</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>
    </div>
</template>
