<script setup>
import {
    ArrowLeft,
    Building2,
    Crown,
    LogOut,
    MessagesSquare,
    Plus,
    Search,
    Settings2,
    Trash2,
    UserMinus,
    UserPlus,
    Users,
} from '@lucide/vue'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import ChatThread from '@/components/chat/ChatThread.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'

const chat = useChatStore()
const auth = useAuthStore()
const toast = useToast()

const search = ref('')
const matches = (text) => !search.value.trim() || text?.toLowerCase().includes(search.value.trim().toLowerCase())

const filteredGroups = computed(() => chat.groups.filter((group) => matches(group.name)))
const filteredSites = computed(() => chat.sites.filter((site) => matches(site.name)))

const selected = computed(() => chat.pageConversation)
const selectedGroup = computed(() =>
    selected.value?.type === 'group' ? (chat.groups.find((group) => group.id === selected.value.id) ?? null) : null,
)
const selectedSite = computed(() =>
    selected.value?.type === 'site' ? (chat.sites.find((site) => site.id === selected.value.id) ?? null) : null,
)

function select(type, id) {
    chat.pageConversation = { type, id }
    if (type === 'site') chat.activeSiteId = id
}

// Pertama dibuka: percakapan teratas, kecuali di layar sempit (tampilkan daftar dulu).
const wide = window.matchMedia('(min-width: 1024px)')
function selectFirst() {
    if (selected.value || !wide.matches) return
    if (chat.groups.length) select('group', chat.groups[0].id)
    else if (chat.sites.length) select('site', chat.sites[0].id)
}
watch(() => [chat.groupsLoaded, chat.sites.length], selectFirst)
onMounted(() => {
    chat.loadGroups()
    selectFirst()
})
onBeforeUnmount(() => (chat.pageConversation = null))

const thread = computed(() => {
    if (selectedGroup.value) {
        const id = selectedGroup.value.id
        return {
            key: `group:${id}`,
            messages: chat.messagesByGroup[id] ?? [],
            hasMore: !!chat.hasMoreByGroup[id],
            typing: Object.values(chat.typingByGroup[id] ?? {}),
            connected: chat.connected,
            error: chat.error,
            replyTo: chat.groupReplyTo[id] ?? null,
            emptyText: `Pesan di grup ini hanya terlihat oleh ${selectedGroup.value.member_count} anggotanya.`,
            send: (body) => chat.sendGroup(id, body),
            sendImage: (file, caption) => chat.sendGroupImage(id, file, caption),
            loadOlder: () => chat.loadOlderGroup(id),
            startReply: (message) => chat.setGroupReply(id, message),
            cancelReply: () => chat.setGroupReply(id, null),
            notifyTyping: () => chat.notifyGroupTyping(id),
            markRead: () => chat.markGroupRead(id),
        }
    }
    if (selectedSite.value) {
        const id = selectedSite.value.id
        return {
            key: `site:${id}`,
            messages: chat.messagesBySite[id] ?? [],
            hasMore: !!chat.hasMoreBySite[id],
            typing: Object.values(chat.typingBySite[id] ?? {}),
            connected: chat.connected,
            error: chat.error,
            replyTo: chat.replyTo,
            emptyText: `Pesan di sini terlihat oleh semua staf ${selectedSite.value.name} secara langsung.`,
            send: (body) => chat.send(body, id),
            sendImage: (file, caption) => chat.sendImage(file, caption, id),
            loadOlder: () => chat.loadOlder(id),
            startReply: chat.startReply,
            cancelReply: chat.cancelReply,
            notifyTyping: () => chat.notifyTyping(id),
            markRead: () => chat.markRead(id),
        }
    }
    return null
})

function preview(group) {
    const last = group.last_message
    if (!last) return 'Belum ada pesan'
    const who = last.user_id === auth.user?.id ? 'Anda' : (last.user_name ?? 'Staf')
    return `${who}: ${last.body ?? (last.has_image ? 'Gambar' : '')}`
}

function sitePreview(siteId) {
    const last = chat.messagesBySite[siteId]?.at(-1)
    if (!last) return 'Chat semua staf site'
    const who = last.user_id === auth.user?.id ? 'Anda' : (last.user_name ?? 'Staf')
    return `${who}: ${last.body ?? (last.image ? 'Gambar' : '')}`
}

function timeLabel(at) {
    if (!at) return ''
    const day = dayjs(at)
    if (day.isSame(dayjs(), 'day')) return day.format('HH:mm')
    if (day.isSame(dayjs().subtract(1, 'day'), 'day')) return 'Kemarin'
    return day.format('D MMM')
}

function initials(name) {
    return (name ?? '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase())
        .join('')
}

// ===== Calon anggota (rekan di site yang dipegang user) =====
const candidates = ref([])
const candidatesLoaded = ref(false)
async function loadCandidates() {
    if (candidatesLoaded.value) return
    try {
        candidates.value = (await api.get('/chat/groups/candidates')).data.data.items
        candidatesLoaded.value = true
    } catch (err) {
        toast.error('Gagal memuat daftar rekan', err.response?.data?.message)
    }
}

const pickerQuery = ref('')
function pickable(exclude = []) {
    const query = pickerQuery.value.trim().toLowerCase()
    return candidates.value.filter(
        (person) =>
            !exclude.includes(person.id) &&
            (!query || [person.name, person.role, person.site].some((value) => value?.toLowerCase().includes(query))),
    )
}

function toggleIn(list, value) {
    const index = list.indexOf(value)
    if (index >= 0) list.splice(index, 1)
    else list.push(value)
}

// ===== Grup baru =====
const createOpen = ref(false)
const creating = ref(false)
const createForm = ref({ name: '', people: [] })

function openCreate() {
    createForm.value = { name: '', people: [] }
    pickerQuery.value = ''
    createOpen.value = true
    loadCandidates()
}

async function createGroup() {
    creating.value = true
    try {
        const group = await chat.createGroup(createForm.value.name, createForm.value.people)
        createOpen.value = false
        select('group', group.id)
        toast.success('Grup dibuat', `${group.name} · ${createForm.value.people.length + 1} anggota`)
    } catch (err) {
        toast.error('Grup belum dibuat', err.response?.data?.message ?? err.message)
    } finally {
        creating.value = false
    }
}

// ===== Pengaturan grup =====
const settingsOpen = ref(false)
const detail = ref(null)
const renameValue = ref('')
const savingName = ref(false)
const addOpen = ref(false)
const addPeople = ref([])
const adding = ref(false)
const confirmLeave = ref(false)
const confirmDelete = ref(false)
const busy = ref(false)

async function loadDetail() {
    try {
        detail.value = (await api.get(`/chat/groups/${selectedGroup.value.id}`)).data.data
        renameValue.value = detail.value.name
    } catch (err) {
        toast.error('Gagal memuat grup', err.response?.data?.message)
        settingsOpen.value = false
    }
}

function openSettings() {
    detail.value = null
    settingsOpen.value = true
    addOpen.value = false
    loadDetail()
}

async function afterChange(message) {
    const groupId = selectedGroup.value?.id
    if (message) toast.success(message)
    await chat.loadGroups()
    if (groupId) chat.announceGroupChange(groupId)
    if (settingsOpen.value && selectedGroup.value) await loadDetail()
}

async function rename() {
    savingName.value = true
    try {
        await api.put(`/chat/groups/${selectedGroup.value.id}`, { name: renameValue.value })
        await afterChange('Nama grup diganti')
    } catch (err) {
        toast.error('Nama belum diganti', err.response?.data?.message)
    } finally {
        savingName.value = false
    }
}

function openAdd() {
    addPeople.value = []
    pickerQuery.value = ''
    addOpen.value = true
    loadCandidates()
}

async function addMembers() {
    adding.value = true
    try {
        await api.post(`/chat/groups/${selectedGroup.value.id}/members`, { user_ids: addPeople.value })
        addOpen.value = false
        await afterChange(`${addPeople.value.length} anggota ditambahkan`)
    } catch (err) {
        toast.error('Anggota belum ditambahkan', err.response?.data?.message)
    } finally {
        adding.value = false
    }
}

async function removeMember(member) {
    busy.value = true
    try {
        await api.delete(`/chat/groups/${selectedGroup.value.id}/members/${member.id}`)
        await afterChange(`${member.name} dikeluarkan`)
    } catch (err) {
        toast.error('Belum dikeluarkan', err.response?.data?.message)
    } finally {
        busy.value = false
    }
}

async function toggleAdmin(member) {
    busy.value = true
    try {
        await api.put(`/chat/groups/${selectedGroup.value.id}/members/${member.id}/admin`, { is_admin: !member.is_admin })
        await afterChange(member.is_admin ? `${member.name} bukan pengelola lagi` : `${member.name} jadi pengelola`)
    } catch (err) {
        toast.error('Belum diubah', err.response?.data?.message)
    } finally {
        busy.value = false
    }
}

async function leaveGroup() {
    const group = selectedGroup.value
    busy.value = true
    try {
        await api.delete(`/chat/groups/${group.id}/members/${auth.user.id}`)
        chat.dropGroup(group.id, { leaveRoom: true })
        settingsOpen.value = false
        toast.success('Anda keluar dari grup', group.name)
    } catch (err) {
        toast.error('Belum keluar', err.response?.data?.message)
    } finally {
        busy.value = false
        confirmLeave.value = false
    }
}

async function deleteGroup() {
    const group = selectedGroup.value
    busy.value = true
    try {
        await api.delete(`/chat/groups/${group.id}`)
        chat.dropGroup(group.id, { leaveRoom: true })
        settingsOpen.value = false
        toast.success('Grup dihapus', group.name)
    } catch (err) {
        toast.error('Grup belum dihapus', err.response?.data?.message)
    } finally {
        busy.value = false
        confirmDelete.value = false
    }
}

const memberIds = computed(() => detail.value?.member_ids ?? [])
</script>

<template>
    <div class="flex h-[calc(100dvh-5.5rem)] gap-3 px-3 pt-3 pb-3 lg:pl-0">
        <!-- ===== Daftar percakapan ===== -->
        <aside
            class="flex w-full flex-col overflow-hidden rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-card) lg:w-80 lg:shrink-0"
            :class="selected && 'max-lg:hidden'"
            aria-label="Percakapan"
        >
            <header class="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
                <h1 class="font-display text-xl font-extrabold tracking-[-0.03em] text-base-50">Chat</h1>
                <BaseButton size="sm" @click="openCreate">
                    <Plus class="size-4" />
                    Grup baru
                </BaseButton>
            </header>
            <label class="relative mx-4 mb-2 block">
                <span class="sr-only">Cari percakapan</span>
                <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                <input v-model="search" type="search" placeholder="Cari grup atau site" class="field-control pl-9" />
            </label>

            <div class="flex-1 overflow-y-auto pb-3">
                <p class="eyebrow px-4 pt-3 pb-1.5">Grup</p>
                <p v-if="chat.groupsLoaded && !chat.groups.length" class="px-4 py-2 text-sm text-pretty text-base-500">
                    Belum ada grup. Tekan <span class="font-semibold text-base-300">Grup baru</span>, beri nama, lalu pilih rekan yang
                    diajak.
                </p>
                <button
                    v-for="group in filteredGroups"
                    :key="`g${group.id}`"
                    type="button"
                    class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-base-850 focus-visible:bg-base-850 focus-visible:outline-none"
                    :class="selectedGroup?.id === group.id && 'bg-accent-500/10'"
                    @click="select('group', group.id)"
                >
                    <span
                        class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-copper-500/12 font-display text-sm font-extrabold text-copper-400"
                        aria-hidden="true"
                        >{{ initials(group.name) }}</span
                    >
                    <span class="min-w-0 flex-1">
                        <span class="flex items-baseline gap-2">
                            <span class="truncate text-sm font-semibold text-base-50">{{ group.name }}</span>
                            <span class="ml-auto shrink-0 font-mono text-[10px] text-base-500 tabular-nums">{{
                                timeLabel(group.last_message?.created_at ?? group.created_at)
                            }}</span>
                        </span>
                        <span class="flex items-center gap-2">
                            <span class="truncate text-xs" :class="group.unread_count ? 'font-medium text-base-200' : 'text-base-500'">{{
                                preview(group)
                            }}</span>
                            <span
                                v-if="group.unread_count"
                                class="ml-auto min-w-5 shrink-0 rounded-full bg-accent-500 px-1.5 text-center font-mono text-[11px] leading-5 font-bold text-white tabular-nums"
                                >{{ group.unread_count > 99 ? '99+' : group.unread_count }}</span
                            >
                        </span>
                    </span>
                </button>

                <template v-if="filteredSites.length">
                    <p class="eyebrow px-4 pt-4 pb-1.5">Chat site</p>
                    <button
                        v-for="site in filteredSites"
                        :key="`s${site.id}`"
                        type="button"
                        class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-base-850 focus-visible:bg-base-850 focus-visible:outline-none"
                        :class="selectedSite?.id === site.id && 'bg-accent-500/10'"
                        @click="select('site', site.id)"
                    >
                        <span
                            class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-base-850 text-base-300"
                            aria-hidden="true"
                        >
                            <Building2 class="size-4" />
                        </span>
                        <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm font-semibold text-base-50">{{ site.name }}</span>
                            <span class="flex items-center gap-2">
                                <span class="truncate text-xs text-base-500">{{ sitePreview(site.id) }}</span>
                                <span
                                    v-if="chat.unreadCount(site.id)"
                                    class="ml-auto min-w-5 shrink-0 rounded-full bg-accent-500 px-1.5 text-center font-mono text-[11px] leading-5 font-bold text-white tabular-nums"
                                    >{{ chat.unreadCount(site.id) }}</span
                                >
                            </span>
                        </span>
                    </button>
                </template>
            </div>
            <p class="flex items-center gap-1.5 border-t border-base-800 px-4 py-2 text-[11px] font-semibold text-base-400">
                <span class="led" :class="chat.connected ? 'text-st-working' : 'text-base-500 led-off'" />
                {{ chat.connected ? 'Tersambung' : 'Terputus -- menyambung ulang…' }}
            </p>
        </aside>

        <!-- ===== Percakapan ===== -->
        <section
            class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-card)"
            :class="!selected && 'max-lg:hidden'"
        >
            <template v-if="thread">
                <header class="flex items-center gap-3 border-b border-base-800 px-4 py-3">
                    <button
                        type="button"
                        class="-ml-1 flex size-8 items-center justify-center rounded-md text-base-400 hover:bg-base-850 hover:text-base-50 lg:hidden"
                        aria-label="Kembali ke daftar percakapan"
                        @click="chat.pageConversation = null"
                    >
                        <ArrowLeft class="size-4" />
                    </button>
                    <div class="min-w-0 flex-1">
                        <h2 class="truncate font-display text-base font-bold tracking-[-0.015em] text-base-50">
                            {{ selectedGroup?.name ?? selectedSite?.name }}
                        </h2>
                        <p class="text-xs text-base-400">
                            <template v-if="selectedGroup">{{ selectedGroup.member_count }} anggota</template>
                            <template v-else
                                >Chat site · {{ (chat.presenceBySite[selectedSite.id] ?? []).length }} sedang membuka chat</template
                            >
                        </p>
                    </div>
                    <BaseButton v-if="selectedGroup" size="sm" variant="outline" @click="openSettings">
                        <Settings2 class="size-4" />
                        <span class="max-sm:sr-only">{{ selectedGroup.is_admin ? 'Kelola grup' : 'Anggota' }}</span>
                    </BaseButton>
                </header>
                <ChatThread :thread="thread" :active="true" />
            </template>
            <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <span class="flex size-14 items-center justify-center rounded-2xl bg-base-850 text-base-400">
                    <MessagesSquare class="size-6" />
                </span>
                <p class="font-display text-lg font-bold text-base-50">Pilih percakapan</p>
                <p class="max-w-xs text-sm text-pretty text-base-500">
                    Buka grup atau chat site di kiri, atau buat grup baru dengan rekan Anda.
                </p>
                <BaseButton @click="openCreate"><Plus class="size-4" /> Grup baru</BaseButton>
            </div>
        </section>

        <!-- ===== Grup baru ===== -->
        <BaseDialog
            :open="createOpen"
            title="Grup baru"
            description="Beri nama grup, lalu pilih rekan yang diajak. Anda menjadi pengelola grup."
            @update:open="(v) => (createOpen = v)"
        >
            <form id="group-form" class="space-y-4" @submit.prevent="createGroup">
                <BaseInput
                    v-model="createForm.name"
                    label="Nama grup"
                    placeholder="Contoh: Tim Gudang Shift Pagi"
                    required
                    maxlength="80"
                />
                <fieldset>
                    <legend class="field-label">Anggota ({{ createForm.people.length }} dipilih)</legend>
                    <label class="relative block">
                        <span class="sr-only">Cari nama, peran, atau site</span>
                        <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                        <input v-model="pickerQuery" type="search" placeholder="Cari nama, peran, atau site" class="field-control pl-9" />
                    </label>
                    <ul class="mt-2 max-h-64 overflow-y-auto rounded-xl border border-base-800">
                        <li v-for="person in pickable()" :key="person.id">
                            <label class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-base-850">
                                <input
                                    type="checkbox"
                                    class="size-4 accent-accent-500"
                                    :checked="createForm.people.includes(person.id)"
                                    @change="toggleIn(createForm.people, person.id)"
                                />
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate text-sm font-medium text-base-100">{{ person.name }}</span>
                                    <span class="block truncate text-xs text-base-500">{{
                                        [person.role, person.site].filter(Boolean).join(' · ')
                                    }}</span>
                                </span>
                            </label>
                        </li>
                        <li v-if="candidatesLoaded && !pickable().length" class="px-3 py-4 text-center text-sm text-base-500">
                            Tidak ada yang cocok.
                        </li>
                        <li v-if="!candidatesLoaded" class="px-3 py-4 text-center text-sm text-base-500">Memuat rekan…</li>
                    </ul>
                    <p class="field-hint">Yang bisa dipilih: rekan di site Anda. Anggota bisa ditambah lagi nanti.</p>
                </fieldset>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="createOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="group-form" :loading="creating">
                    <Users class="size-4" />
                    Buat grup
                </BaseButton>
            </template>
        </BaseDialog>

        <!-- ===== Kelola grup / anggota ===== -->
        <BaseDialog
            :open="settingsOpen"
            :title="selectedGroup?.is_admin ? 'Kelola grup' : 'Anggota grup'"
            :description="selectedGroup?.name ?? ''"
            size="lg"
            @update:open="(v) => (settingsOpen = v)"
        >
            <p v-if="!detail" class="text-sm text-base-500">Memuat…</p>
            <div v-else class="space-y-5">
                <form v-if="detail.is_admin" class="flex items-end gap-2" @submit.prevent="rename">
                    <BaseInput v-model="renameValue" label="Nama grup" required maxlength="80" class="flex-1" />
                    <BaseButton
                        type="submit"
                        variant="outline"
                        :loading="savingName"
                        :disabled="!renameValue.trim() || renameValue === detail.name"
                    >
                        Simpan
                    </BaseButton>
                </form>

                <div>
                    <div class="mb-2 flex items-center justify-between gap-2">
                        <p class="eyebrow">{{ detail.members.length }} anggota</p>
                        <BaseButton v-if="detail.is_admin && !addOpen" size="sm" variant="outline" @click="openAdd">
                            <UserPlus class="size-4" />
                            Tambah anggota
                        </BaseButton>
                    </div>

                    <div v-if="addOpen" class="mb-3 rounded-xl border border-base-800 p-3">
                        <label class="relative block">
                            <span class="sr-only">Cari rekan</span>
                            <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                            <input v-model="pickerQuery" type="search" placeholder="Cari rekan" class="field-control pl-9" />
                        </label>
                        <ul class="mt-2 max-h-52 overflow-y-auto">
                            <li v-for="person in pickable(memberIds)" :key="person.id">
                                <label class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-base-850">
                                    <input
                                        type="checkbox"
                                        class="size-4 accent-accent-500"
                                        :checked="addPeople.includes(person.id)"
                                        @change="toggleIn(addPeople, person.id)"
                                    />
                                    <span class="min-w-0 flex-1 truncate text-sm text-base-100">{{ person.name }}</span>
                                    <span class="truncate text-xs text-base-500">{{ person.site }}</span>
                                </label>
                            </li>
                            <li v-if="candidatesLoaded && !pickable(memberIds).length" class="px-2 py-3 text-center text-sm text-base-500">
                                Semua rekan sudah menjadi anggota.
                            </li>
                        </ul>
                        <div class="mt-2 flex justify-end gap-2">
                            <BaseButton size="sm" variant="ghost" @click="addOpen = false">Batal</BaseButton>
                            <BaseButton size="sm" :disabled="!addPeople.length" :loading="adding" @click="addMembers">
                                Tambahkan {{ addPeople.length || '' }}
                            </BaseButton>
                        </div>
                    </div>

                    <ul class="divide-y divide-base-800 rounded-xl border border-base-800">
                        <li v-for="member in detail.members" :key="member.id" class="flex items-center gap-3 px-3 py-2.5">
                            <span
                                class="flex size-8 shrink-0 items-center justify-center rounded-full bg-base-800 font-mono text-[11px] text-copper-400"
                                >{{ initials(member.name) }}</span
                            >
                            <span class="min-w-0 flex-1">
                                <span class="flex items-center gap-1.5 text-sm font-medium text-base-100">
                                    <span class="truncate">{{ member.name }}</span>
                                    <span v-if="member.id === auth.user?.id" class="text-xs font-normal text-base-500">(Anda)</span>
                                </span>
                                <span class="block truncate text-xs text-base-500">{{ member.site ?? '—' }}</span>
                            </span>
                            <span
                                v-if="member.is_admin"
                                class="inline-flex items-center gap-1 rounded-full bg-copper-500/12 px-2 py-0.5 text-[11px] font-semibold text-copper-400"
                            >
                                <Crown class="size-3" /> Pengelola
                            </span>
                            <template v-if="detail.is_admin && member.id !== auth.user?.id">
                                <BaseButton
                                    size="icon"
                                    variant="ghost"
                                    :disabled="busy"
                                    :aria-label="
                                        member.is_admin ? `Batalkan ${member.name} sebagai pengelola` : `Jadikan ${member.name} pengelola`
                                    "
                                    :title="member.is_admin ? 'Batalkan pengelola' : 'Jadikan pengelola'"
                                    @click="toggleAdmin(member)"
                                >
                                    <Crown class="size-4" />
                                </BaseButton>
                                <BaseButton
                                    size="icon"
                                    variant="ghost"
                                    :disabled="busy"
                                    :aria-label="`Keluarkan ${member.name}`"
                                    title="Keluarkan dari grup"
                                    @click="removeMember(member)"
                                >
                                    <UserMinus class="size-4" />
                                </BaseButton>
                            </template>
                        </li>
                    </ul>
                </div>
            </div>
            <template #footer>
                <BaseButton variant="danger-outline" :disabled="!detail" @click="confirmLeave = true">
                    <LogOut class="size-4" />
                    Keluar dari grup
                </BaseButton>
                <BaseButton v-if="detail?.is_admin" variant="danger" @click="confirmDelete = true">
                    <Trash2 class="size-4" />
                    Hapus grup
                </BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="confirmLeave"
            :title="`Keluar dari ${selectedGroup?.name ?? 'grup'}?`"
            description="Anda tidak lagi menerima pesan grup ini. Pengelola bisa menambahkan Anda kembali."
            confirm-label="Keluar dari grup"
            :loading="busy"
            @confirm="leaveGroup"
            @update:open="(v) => (confirmLeave = v)"
        />
        <ConfirmDialog
            :open="confirmDelete"
            :title="`Hapus grup ${selectedGroup?.name ?? ''}?`"
            description="Grup dan semua pesannya dihapus untuk semua anggota. Tidak bisa dibatalkan."
            confirm-label="Hapus grup"
            :loading="busy"
            @confirm="deleteGroup"
            @update:open="(v) => (confirmDelete = v)"
        />
    </div>
</template>
