<script setup>
import { Plus, Send, Trash2 } from '@lucide/vue'
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
    await Promise.all([loadBindings(), loadOrganizations()])
})
</script>

<template>
    <div>
        <PageHeader title="Bot Telegram" subtitle="Hubungkan grup/chat Telegram untuk notifikasi & kontrol">
            <template #actions>
                <BaseButton @click="dialogOpen = true"><Plus class="size-4" /> Tambah Binding</BaseButton>
            </template>
        </PageHeader>

        <div class="p-8">
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
    </div>
</template>
