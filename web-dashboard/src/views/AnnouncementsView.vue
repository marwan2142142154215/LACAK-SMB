<script setup>
import { CheckCheck, Eye, Megaphone, Plus, Trash2 } from '@lucide/vue'
import dayjs from 'dayjs'
import { onMounted, ref } from 'vue'

import BaseBadge from '@/components/ui/BaseBadge.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { refreshWorkCounters } from '@/lib/workCounters'

const toast = useToast()

const loaded = ref(false)
const items = ref([])
const canCreate = ref(false)
const roleOptions = ref([])
const siteOptions = ref([])

async function load() {
    try {
        const { data } = await api.get('/announcements')
        items.value = data.data.items
        canCreate.value = data.data.can_create
        roleOptions.value = data.data.roles
        siteOptions.value = data.data.sites
        loaded.value = true
    } catch (err) {
        toast.error('Gagal memuat pengumuman', err.response?.data?.message)
    }
}

async function markRead(item) {
    try {
        await api.post(`/announcements/${item.id}/read`)
        item.is_read = true
        refreshWorkCounters()
    } catch (err) {
        toast.error('Belum tertandai', err.response?.data?.message)
    }
}

async function markAllRead() {
    await Promise.all(items.value.filter((item) => !item.is_read).map((item) => api.post(`/announcements/${item.id}/read`).catch(() => {})))
    items.value.forEach((item) => (item.is_read = true))
    refreshWorkCounters()
}

// ===== Tulis =====
const formOpen = ref(false)
const saving = ref(false)
const form = ref(null)

function openForm() {
    form.value = {
        title: '',
        body: '',
        roles: [],
        sites: siteOptions.value.map((site) => site.id),
        is_important: false,
        expires_at: '',
        notify_telegram: true,
    }
    formOpen.value = true
}

function toggleIn(list, value) {
    const index = list.indexOf(value)
    if (index >= 0) list.splice(index, 1)
    else list.push(value)
}

async function publish() {
    saving.value = true
    try {
        const allSites = form.value.sites.length === siteOptions.value.length
        await api.post('/announcements', {
            title: form.value.title,
            body: form.value.body,
            roles: form.value.roles,
            organization_ids: allSites ? [] : form.value.sites,
            is_important: form.value.is_important,
            notify_telegram: form.value.notify_telegram,
            ...(form.value.expires_at ? { expires_at: dayjs(form.value.expires_at).endOf('day').toISOString() } : {}),
        })
        toast.success('Pengumuman diterbitkan', form.value.title)
        formOpen.value = false
        load()
    } catch (err) {
        toast.error('Pengumuman belum terbit', err.response?.data?.message)
    } finally {
        saving.value = false
    }
}

// ===== Pembaca & hapus =====
const readersOf = ref(null)
const readers = ref([])
async function showReaders(item) {
    readersOf.value = item
    readers.value = []
    try {
        const { data } = await api.get(`/announcements/${item.id}/readers`)
        readers.value = data.data.items
    } catch (err) {
        toast.error('Gagal memuat pembaca', err.response?.data?.message)
    }
}

const deleteTarget = ref(null)
const deleting = ref(false)
async function remove() {
    deleting.value = true
    try {
        await api.delete(`/announcements/${deleteTarget.value.id}`)
        toast.success('Pengumuman dihapus')
        load()
        refreshWorkCounters()
    } catch (err) {
        toast.error('Belum terhapus', err.response?.data?.message)
    } finally {
        deleting.value = false
        deleteTarget.value = null
    }
}

const roleLabel = (value) => roleOptions.value.find((role) => role.value === value)?.label ?? value

onMounted(load)
</script>

<template>
    <div>
        <PageHeader
            eyebrow="Kerja"
            title="Pengumuman"
            subtitle="Kabar dari pengelola site. Pengumuman baru tampil di atas setiap halaman sampai ditandai sudah dibaca."
        >
            <template #actions>
                <BaseButton v-if="items.some((item) => !item.is_read)" variant="outline" @click="markAllRead">
                    <CheckCheck class="size-4" />
                    Tandai semua dibaca
                </BaseButton>
                <BaseButton v-if="canCreate" @click="openForm">
                    <Plus class="size-4" />
                    Tulis pengumuman
                </BaseButton>
            </template>
        </PageHeader>

        <div class="mx-auto max-w-3xl p-4 sm:p-8">
            <div v-if="!loaded" class="py-12 text-center text-sm text-base-500">Memuat pengumuman…</div>
            <div v-else-if="!items.length" class="rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-card)">
                <EmptyState
                    :icon="Megaphone"
                    title="Belum ada pengumuman"
                    :description="
                        canCreate
                            ? 'Tekan Tulis pengumuman untuk mengabari staf di site Anda.'
                            : 'Pengumuman dari pengelola site Anda muncul di sini.'
                    "
                />
            </div>
            <ol v-else class="space-y-4">
                <li
                    v-for="item in items"
                    :key="item.id"
                    class="relative rounded-2xl border bg-base-900 p-5 shadow-(--shadow-card)"
                    :class="[item.is_important ? 'border-danger-500/40' : 'border-base-800', !item.is_read && 'ring-1 ring-accent-500/40']"
                >
                    <div class="flex flex-wrap items-center gap-2">
                        <span v-if="!item.is_read" class="beacon" aria-label="Belum dibaca" />
                        <BaseBadge v-if="item.is_important" variant="danger">Penting</BaseBadge>
                        <span class="text-xs text-base-500">
                            {{ item.is_mine ? 'Anda' : (item.author_name ?? '—') }} ·
                            {{ dayjs(item.created_at).format('D MMM YYYY, HH:mm') }}
                        </span>
                        <span v-if="item.expires_at" class="text-xs text-base-500"
                            >· tampil sampai {{ dayjs(item.expires_at).format('D MMM') }}</span
                        >
                    </div>
                    <h2 class="mt-2 font-display text-xl font-extrabold tracking-[-0.02em] text-base-50">{{ item.title }}</h2>
                    <p class="mt-2 text-[15px] leading-relaxed whitespace-pre-line text-pretty text-base-200">{{ item.body }}</p>
                    <div class="mt-4 flex flex-wrap items-center gap-1.5">
                        <span
                            v-for="role in item.roles"
                            :key="role"
                            class="rounded-full bg-base-850 px-2.5 py-0.5 text-xs font-semibold text-base-300"
                            >{{ roleLabel(role) }}</span
                        >
                        <span v-if="!item.roles.length" class="rounded-full bg-base-850 px-2.5 py-0.5 text-xs font-semibold text-base-300"
                            >Semua peran</span
                        >
                        <span class="rounded-full bg-copper-500/12 px-2.5 py-0.5 text-xs font-semibold text-copper-400">{{
                            item.sites.length ? item.sites.join(', ') : 'Semua site'
                        }}</span>
                        <div class="ml-auto flex gap-2">
                            <BaseButton v-if="item.read_count !== null" size="sm" variant="ghost" @click="showReaders(item)">
                                <Eye class="size-4" />
                                {{ item.read_count }} membaca
                            </BaseButton>
                            <BaseButton
                                v-if="item.can_delete"
                                size="sm"
                                variant="ghost"
                                :aria-label="`Hapus ${item.title}`"
                                @click="deleteTarget = item"
                            >
                                <Trash2 class="size-4" />
                            </BaseButton>
                            <BaseButton v-if="!item.is_read" size="sm" variant="outline" @click="markRead(item)">
                                <CheckCheck class="size-4" />
                                Sudah dibaca
                            </BaseButton>
                        </div>
                    </div>
                </li>
            </ol>
        </div>

        <BaseDialog
            :open="formOpen"
            title="Tulis pengumuman"
            description="Penerima melihatnya di dashboard; bisa juga dikirim ke chat Telegram site."
            size="lg"
            @update:open="(v) => (formOpen = v)"
        >
            <form v-if="form" id="announcement-form" class="space-y-4" @submit.prevent="publish">
                <BaseInput v-model="form.title" label="Judul" required maxlength="120" placeholder="Contoh: Libur nasional Senin" />
                <label class="block">
                    <span class="field-label">Isi <span class="text-danger-400" aria-hidden="true">*</span></span>
                    <textarea v-model="form.body" rows="5" required maxlength="5000" class="field-control" />
                </label>
                <fieldset>
                    <legend class="field-label">Untuk peran</legend>
                    <div class="flex flex-wrap gap-2">
                        <label
                            v-for="role in roleOptions"
                            :key="role.value"
                            class="inline-flex cursor-pointer items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
                            :class="
                                form.roles.includes(role.value)
                                    ? 'border-transparent bg-base-50 text-base-950'
                                    : 'border-base-700 text-base-300 hover:border-base-600'
                            "
                        >
                            <input
                                type="checkbox"
                                class="sr-only"
                                :checked="form.roles.includes(role.value)"
                                @change="toggleIn(form.roles, role.value)"
                            />
                            {{ role.label }}
                        </label>
                    </div>
                    <p class="field-hint">Tidak ada yang dipilih = semua peran.</p>
                </fieldset>
                <fieldset v-if="siteOptions.length">
                    <legend class="field-label">Untuk site</legend>
                    <div class="flex flex-wrap gap-2">
                        <label
                            v-for="site in siteOptions"
                            :key="site.id"
                            class="inline-flex cursor-pointer items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
                            :class="
                                form.sites.includes(site.id)
                                    ? 'border-transparent bg-copper-500/15 text-copper-400'
                                    : 'border-base-700 text-base-300 hover:border-base-600'
                            "
                        >
                            <input
                                type="checkbox"
                                class="sr-only"
                                :checked="form.sites.includes(site.id)"
                                @change="toggleIn(form.sites, site.id)"
                            />
                            {{ site.name }}
                        </label>
                    </div>
                </fieldset>
                <div class="grid gap-3 sm:grid-cols-2">
                    <BaseInput v-model="form.expires_at" type="date" label="Tampil sampai (opsional)" :min="dayjs().format('YYYY-MM-DD')" />
                    <div class="space-y-2 pt-6">
                        <label class="flex items-center gap-2 text-sm text-base-200">
                            <input v-model="form.is_important" type="checkbox" class="size-4 accent-accent-500" />
                            Tandai penting
                        </label>
                        <label class="flex items-center gap-2 text-sm text-base-200">
                            <input v-model="form.notify_telegram" type="checkbox" class="size-4 accent-accent-500" />
                            Kirim juga ke Telegram site
                        </label>
                    </div>
                </div>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="formOpen = false">Batal</BaseButton>
                <BaseButton
                    type="submit"
                    form="announcement-form"
                    :loading="saving"
                    :disabled="form && siteOptions.length > 0 && !form.sites.length"
                >
                    <Megaphone class="size-4" />
                    Terbitkan
                </BaseButton>
            </template>
        </BaseDialog>

        <BaseDialog
            :open="!!readersOf"
            :title="`Pembaca: ${readersOf?.title ?? ''}`"
            size="sm"
            @update:open="(v) => !v && (readersOf = null)"
        >
            <p v-if="!readers.length" class="text-sm text-base-500">Belum ada yang menandai sudah dibaca.</p>
            <ul v-else class="divide-y divide-base-800">
                <li v-for="reader in readers" :key="reader.user_id" class="flex justify-between gap-3 py-2 text-sm">
                    <span class="text-base-100">{{ reader.name }}</span>
                    <span class="text-base-500">{{ dayjs(reader.read_at).format('D MMM HH:mm') }}</span>
                </li>
            </ul>
        </BaseDialog>

        <ConfirmDialog
            :open="!!deleteTarget"
            :title="`Hapus pengumuman ${deleteTarget?.title ?? ''}?`"
            description="Pengumuman hilang dari dashboard semua penerima."
            confirm-label="Hapus pengumuman"
            :loading="deleting"
            @confirm="remove"
            @update:open="(v) => !v && (deleteTarget = null)"
        />
    </div>
</template>
