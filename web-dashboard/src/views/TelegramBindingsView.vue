<script setup>
import { Plus, Send, Trash2, UserCheck } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { onMounted, ref } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const toast = useToast()

const bindings = ref([])
const organizations = ref([])
const loading = ref(true)
const dialogOpen = ref(false)
const submitting = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)

const form = ref({
    organization_id: auth.user?.organization_id ?? null,
    telegram_chat_id: '',
    bot_token_ref: '',
})

// Tautan akun Telegram pribadi staf -> akun login staf -- supaya bot bisa
// menegakkan izin SEBENARNYA milik pengirim pesan (role/permission akun
// staf-nya), bukan cuma izin akun layanan bot yang dipukul rata ke semua
// orang di grup (lihat backend-api TelegramUserLinkController).
const staffLinks = ref([])
const staffUsers = ref([])
const linkDialogOpen = ref(false)
const linkSubmitting = ref(false)
const linkDeleteTarget = ref(null)
const linkDeleting = ref(false)
const linkForm = ref({ user_id: null, telegram_user_id: '', telegram_username: '' })

async function loadStaffLinks() {
    const response = await api.get('/telegram-user-links')
    staffLinks.value = response.data.data
}

async function loadStaffUsers() {
    // GET /users mengharuskan permission 'users.manage', yang di seeder cuma
    // dipegang super_admin (site_admin punya 'telegram.manage' tapi BUKAN
    // 'users.manage') -- tanpa guard ini, site_admin yang buka halaman ini
    // kena 403 dari Promise.all dan seluruh halaman gagal render.
    if (!auth.isSuperAdmin) return
    const response = await api.get('/users', { params: { per_page: 100 } })
    staffUsers.value = response.data.data.items
    if (!linkForm.value.user_id && staffUsers.value.length) {
        linkForm.value.user_id = staffUsers.value[0].id
    }
}

async function submitLinkForm() {
    linkSubmitting.value = true
    try {
        await api.post('/telegram-user-links', linkForm.value)
        toast.success('Akun Telegram berhasil ditautkan')
        linkDialogOpen.value = false
        linkForm.value.telegram_user_id = ''
        linkForm.value.telegram_username = ''
        await loadStaffLinks()
    } catch (err) {
        toast.error('Gagal menautkan akun', err.response?.data?.message)
    } finally {
        linkSubmitting.value = false
    }
}

async function confirmDeleteLink() {
    linkDeleting.value = true
    try {
        await api.delete(`/telegram-user-links/${linkDeleteTarget.value.id}`)
        toast.success('Tautan dihapus')
        linkDeleteTarget.value = null
        await loadStaffLinks()
    } catch (err) {
        toast.error('Gagal menghapus tautan', err.response?.data?.message)
    } finally {
        linkDeleting.value = false
    }
}

async function loadBindings() {
    loading.value = true
    try {
        const response = await api.get('/telegram-bindings')
        bindings.value = response.data.data
    } finally {
        loading.value = false
    }
}

async function loadOrganizations() {
    if (!auth.isSuperAdmin) return
    const response = await api.get('/organizations')
    organizations.value = response.data.data.items
    if (!form.value.organization_id && organizations.value.length) {
        form.value.organization_id = organizations.value[0].id
    }
}

async function submitForm() {
    submitting.value = true
    try {
        await api.post('/telegram-bindings', form.value)
        toast.success('Binding Telegram dibuat')
        dialogOpen.value = false
        await loadBindings()
    } catch (err) {
        toast.error('Gagal membuat binding', err.response?.data?.message)
    } finally {
        submitting.value = false
    }
}

async function confirmDelete() {
    deleting.value = true
    try {
        await api.delete(`/telegram-bindings/${deleteTarget.value.id}`)
        toast.success('Binding dihapus')
        deleteTarget.value = null
        await loadBindings()
    } catch (err) {
        toast.error('Gagal menghapus binding', err.response?.data?.message)
    } finally {
        deleting.value = false
    }
}

onMounted(async () => {
    await Promise.all([loadBindings(), loadOrganizations(), loadStaffLinks(), loadStaffUsers()])
})
</script>

<template>
    <div>
        <PageHeader title="Bot Telegram" subtitle="Hubungkan grup/chat Telegram untuk notifikasi & kontrol">
            <template #actions>
                <BaseButton v-if="auth.isSuperAdmin" variant="outline" @click="linkDialogOpen = true">
                    <UserCheck class="size-4" /> Tautkan Akun Staf
                </BaseButton>
                <BaseButton @click="dialogOpen = true"><Plus class="size-4" /> Tambah Binding</BaseButton>
            </template>
        </PageHeader>

        <div class="space-y-6 p-8">
            <BaseCard title="Semua Binding">
                <div v-if="loading" class="py-12 text-center text-sm text-base-500">Memuat...</div>
                <div v-else-if="bindings.length === 0" class="py-12 text-center text-sm text-base-500">Belum ada binding Telegram.</div>
                <div v-else class="space-y-3">
                    <div
                        v-for="binding in bindings"
                        :key="binding.id"
                        class="flex items-center justify-between rounded-xl border border-base-800 bg-base-850/60 p-4"
                    >
                        <div class="flex items-center gap-3">
                            <div class="flex size-10 items-center justify-center rounded-lg bg-base-800">
                                <Send class="size-5 text-base-400" />
                            </div>
                            <div>
                                <p class="font-mono text-sm text-base-100">{{ binding.telegram_chat_id }}</p>
                                <p class="font-mono text-xs text-base-500">{{ binding.bot_token_ref_masked }}</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-3">
                            <BaseBadge :variant="binding.is_active ? 'success' : 'neutral'">
                                {{ binding.is_active ? 'Aktif' : 'Nonaktif' }}
                            </BaseBadge>
                            <button type="button" class="text-base-500 hover:text-danger-400" @click="deleteTarget = binding">
                                <Trash2 class="size-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </BaseCard>

            <BaseCard title="Tautan Akun Staf">
                <p class="mb-4 text-xs text-base-500">
                    Bot menegakkan izin sesuai role akun staf yang ditautkan ke akun Telegram pribadinya -- staf yang belum ditautkan di
                    sini tidak bisa pakai perintah apa pun di bot (kecuali /start dan /help).
                </p>
                <div v-if="staffLinks.length === 0" class="py-8 text-center text-sm text-base-500">Belum ada akun staf yang ditautkan.</div>
                <div v-else class="space-y-3">
                    <div
                        v-for="link in staffLinks"
                        :key="link.id"
                        class="flex items-center justify-between rounded-xl border border-base-800 bg-base-850/60 p-4"
                    >
                        <div class="flex items-center gap-3">
                            <div class="flex size-10 items-center justify-center rounded-lg bg-base-800">
                                <UserCheck class="size-5 text-base-400" />
                            </div>
                            <div>
                                <p class="text-sm text-base-100">{{ link.user.name }} ({{ link.user.username }})</p>
                                <p class="font-mono text-xs text-base-500">
                                    Telegram: {{ link.telegram_user_id }}<span v-if="link.telegram_username"> · @{{ link.telegram_username }}</span>
                                </p>
                            </div>
                        </div>
                        <button type="button" class="text-base-500 hover:text-danger-400" @click="linkDeleteTarget = link">
                            <Trash2 class="size-4" />
                        </button>
                    </div>
                </div>
            </BaseCard>
        </div>

        <DialogRoot :open="dialogOpen" @update:open="(v) => (dialogOpen = v)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl"
                >
                    <DialogTitle class="text-base font-semibold text-base-50">Tambah Binding Telegram</DialogTitle>
                    <DialogDescription class="sr-only">Formulir untuk menambah binding Telegram baru</DialogDescription>
                    <form class="mt-5 space-y-4" @submit.prevent="submitForm">
                        <label v-if="auth.isSuperAdmin" class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Site</span>
                            <select
                                v-model="form.organization_id"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                            </select>
                        </label>
                        <BaseInput v-model="form.telegram_chat_id" label="Chat ID Telegram" placeholder="-100123456789" required />
                        <BaseInput v-model="form.bot_token_ref" label="Referensi Token Bot" placeholder="env:TELEGRAM_BOT_TOKEN" required />
                        <p class="text-xs text-base-500">
                            Isi referensi ke secret manager/.env, bukan token asli — token asli tidak pernah disimpan di database.
                        </p>
                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                            <BaseButton type="submit" :loading="submitting">Simpan</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <ConfirmDialog
            :open="!!deleteTarget"
            title="Hapus binding ini?"
            :description="deleteTarget?.telegram_chat_id"
            confirm-label="Hapus"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />

        <DialogRoot :open="linkDialogOpen" @update:open="(v) => (linkDialogOpen = v)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
                <DialogContent
                    class="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-base-800 bg-base-900 p-6 shadow-2xl"
                >
                    <DialogTitle class="text-base font-semibold text-base-50">Tautkan Akun Staf ke Telegram</DialogTitle>
                    <DialogDescription class="sr-only">Formulir untuk menautkan akun Telegram staf</DialogDescription>
                    <form class="mt-5 space-y-4" @submit.prevent="submitLinkForm">
                        <label class="block">
                            <span class="mb-1.5 block text-xs font-medium text-base-300">Akun Staf</span>
                            <select
                                v-model="linkForm.user_id"
                                class="w-full rounded-lg border border-base-700 bg-base-850 px-3.5 py-2.5 text-sm text-base-50 outline-none focus:border-accent-500"
                            >
                                <option v-for="u in staffUsers" :key="u.id" :value="u.id">{{ u.name }} ({{ u.username }})</option>
                            </select>
                        </label>
                        <BaseInput v-model="linkForm.telegram_user_id" label="ID Telegram" placeholder="123456789" required />
                        <BaseInput v-model="linkForm.telegram_username" label="Username Telegram (opsional)" placeholder="username" />
                        <p class="text-xs text-base-500">
                            Minta staf kirim /start ke bot dulu -- ID Telegram-nya ditampilkan di balasan bot, salin dari sana supaya tidak
                            salah tautan ke orang lain.
                        </p>
                        <div class="flex justify-end gap-3 pt-2">
                            <BaseButton type="button" variant="ghost" @click="linkDialogOpen = false">Batal</BaseButton>
                            <BaseButton type="submit" :loading="linkSubmitting">Simpan</BaseButton>
                        </div>
                    </form>
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <ConfirmDialog
            :open="!!linkDeleteTarget"
            title="Hapus tautan ini?"
            :description="linkDeleteTarget?.user?.name"
            confirm-label="Hapus"
            :loading="linkDeleting"
            @update:open="(v) => !v && (linkDeleteTarget = null)"
            @confirm="confirmDeleteLink"
        />
    </div>
</template>
