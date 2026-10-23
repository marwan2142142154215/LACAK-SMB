<script setup>
import { Plus, Send, Trash2, UserCheck } from '@lucide/vue'
import { onMounted, ref } from 'vue'

import BaseButton from '@/components/ui/BaseButton.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Readout from '@/components/ui/Readout.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
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
        const response = await api.get('/telegram-bindings', { params: { per_page: 100 } })
        bindings.value = response.data.data.items
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

function siteName(binding) {
    return organizations.value.find((org) => org.id === binding.organization_id)?.name ?? null
}

function bindingMenu(binding) {
    return [{ label: 'Lepas grup', icon: Trash2, onSelect: () => (deleteTarget.value = binding), danger: true }]
}

function linkMenu(link) {
    return [{ label: 'Hapus tautan', icon: Trash2, onSelect: () => (linkDeleteTarget.value = link), danger: true }]
}

onMounted(async () => {
    await Promise.all([loadBindings(), loadOrganizations(), loadStaffLinks(), loadStaffUsers()])
})
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Akses"
            title="Bot Telegram"
            subtitle="Grup Telegram menerima peringatan pelanggaran dari site-nya, dan staf yang tertaut bisa mengunci atau membuka device lewat bot."
        >
            <template #actions>
                <BaseButton v-if="auth.isSuperAdmin" variant="outline" @click="linkDialogOpen = true"
                    ><UserCheck class="size-4" /> Tautkan staf</BaseButton
                >
                <BaseButton @click="dialogOpen = true"><Plus class="size-4" /> Hubungkan grup</BaseButton>
            </template>
            <template v-if="!loading" #readouts>
                <Readout label="Grup terhubung" :value="bindings.length" led="accent" />
                <Readout label="Staf tertaut" :value="staffLinks.length" :led="staffLinks.length ? 'copper' : 'muted'" />
            </template>
        </PageHeader>

        <div class="grid items-start gap-6 p-4 sm:p-8 xl:grid-cols-2">
            <BaseCard title="Grup notifikasi" :count="loading ? null : bindings.length" flush>
                <div v-if="loading" class="px-5 py-12 text-center text-sm text-base-500">Memuat grup…</div>
                <EmptyState
                    v-else-if="bindings.length === 0"
                    :icon="Send"
                    title="Belum ada grup terhubung"
                    description="Tambahkan bot ke grup Telegram tim, lalu hubungkan chat ID grup itu ke site di sini."
                >
                    <BaseButton @click="dialogOpen = true"><Plus class="size-4" /> Hubungkan grup</BaseButton>
                </EmptyState>
                <ul v-else class="divide-y divide-base-800/70">
                    <li v-for="binding in bindings" :key="binding.id" class="flex items-center gap-4 px-5 py-4">
                        <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-base-800">
                            <Send class="size-4 text-base-300" />
                        </span>
                        <div class="min-w-0 flex-1">
                            <p class="truncate text-sm font-medium text-base-50">{{ siteName(binding) ?? 'Site Anda' }}</p>
                            <p class="truncate font-mono text-xs text-base-500">
                                chat {{ binding.telegram_chat_id }} · {{ binding.bot_token_ref_masked }}
                            </p>
                        </div>
                        <StatusDot :status="binding.is_active ? 'active' : 'inactive'" />
                        <RowMenu :items="bindingMenu(binding)" :label="`Aksi untuk grup ${binding.telegram_chat_id}`" />
                    </li>
                </ul>
            </BaseCard>

            <BaseCard
                title="Staf tertaut"
                :count="staffLinks.length"
                subtitle="Bot mengikuti izin akun staf yang tertaut. Staf yang belum tertaut hanya bisa memakai /start dan /help."
                flush
            >
                <EmptyState
                    v-if="staffLinks.length === 0"
                    :icon="UserCheck"
                    title="Belum ada staf tertaut"
                    description="Minta staf mengirim /start ke bot, lalu tautkan ID Telegram yang dibalas bot ke akun staf mereka."
                >
                    <BaseButton v-if="auth.isSuperAdmin" variant="outline" @click="linkDialogOpen = true"
                        ><UserCheck class="size-4" /> Tautkan staf</BaseButton
                    >
                </EmptyState>
                <ul v-else class="divide-y divide-base-800/70">
                    <li v-for="link in staffLinks" :key="link.id" class="flex items-center gap-4 px-5 py-4">
                        <span
                            class="flex size-9 shrink-0 items-center justify-center rounded-md bg-base-800 font-mono text-sm text-base-200"
                        >
                            {{ link.user.name?.charAt(0)?.toUpperCase() }}
                        </span>
                        <div class="min-w-0 flex-1">
                            <p class="truncate text-sm font-medium text-base-50">{{ link.user.name }}</p>
                            <p class="truncate font-mono text-xs text-base-500">
                                id {{ link.telegram_user_id }}<span v-if="link.telegram_username"> · @{{ link.telegram_username }}</span>
                            </p>
                        </div>
                        <RowMenu :items="linkMenu(link)" :label="`Aksi untuk tautan ${link.user.name}`" />
                    </li>
                </ul>
            </BaseCard>
        </div>

        <BaseDialog
            :open="dialogOpen"
            title="Hubungkan grup Telegram"
            description="Bot harus sudah menjadi anggota grup sebelum dihubungkan."
            @update:open="(v) => (dialogOpen = v)"
        >
            <form id="binding-form" class="space-y-4" @submit.prevent="submitForm">
                <BaseSelect v-if="auth.isSuperAdmin" v-model="form.organization_id" label="Site" required>
                    <option v-for="org in organizations" :key="org.id" :value="org.id">{{ org.name }}</option>
                </BaseSelect>
                <BaseInput v-model="form.telegram_chat_id" label="Chat ID grup" placeholder="-100123456789" required />
                <BaseInput
                    v-model="form.bot_token_ref"
                    label="Referensi token bot"
                    placeholder="env:TELEGRAM_BOT_TOKEN"
                    required
                    hint="Nama variabel di .env atau secret manager. Token aslinya tidak pernah disimpan di database."
                />
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="dialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="binding-form" :loading="submitting">Hubungkan grup</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!deleteTarget"
            :title="`Lepas grup ${deleteTarget?.telegram_chat_id ?? ''}?`"
            description="Grup ini berhenti menerima peringatan, dan perintah dari grup ini tidak lagi dijalankan."
            confirm-label="Lepas grup"
            :loading="deleting"
            @update:open="(v) => !v && (deleteTarget = null)"
            @confirm="confirmDelete"
        />

        <BaseDialog
            :open="linkDialogOpen"
            title="Tautkan staf ke Telegram"
            description="Salin ID Telegram dari balasan bot atas /start, supaya tidak tertaut ke orang yang salah."
            @update:open="(v) => (linkDialogOpen = v)"
        >
            <form id="link-form" class="space-y-4" @submit.prevent="submitLinkForm">
                <BaseSelect v-model="linkForm.user_id" label="Akun staf" required>
                    <option v-for="u in staffUsers" :key="u.id" :value="u.id">{{ u.name }} ({{ u.username }})</option>
                </BaseSelect>
                <div class="grid gap-4 sm:grid-cols-2">
                    <BaseInput v-model="linkForm.telegram_user_id" label="ID Telegram" placeholder="123456789" required />
                    <BaseInput v-model="linkForm.telegram_username" label="Username Telegram" placeholder="opsional" />
                </div>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="linkDialogOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="link-form" :loading="linkSubmitting">Tautkan staf</BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="!!linkDeleteTarget"
            :title="`Hapus tautan ${linkDeleteTarget?.user?.name ?? ''}?`"
            description="Staf ini tidak bisa lagi memakai perintah bot sampai ditautkan ulang."
            confirm-label="Hapus tautan"
            :loading="linkDeleting"
            @update:open="(v) => !v && (linkDeleteTarget = null)"
            @confirm="confirmDeleteLink"
        />
    </div>
</template>
