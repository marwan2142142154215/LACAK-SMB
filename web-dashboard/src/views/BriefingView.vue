<script setup>
import { Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Presentation, Square, Users, Video, VideoOff } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import LiveVideoTile from '@/components/live/LiveVideoTile.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useBriefingCall } from '@/composables/useBriefingCall'
import { formatElapsed, useNow } from '@/composables/useNow'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'

// Daftar briefing dimuat ulang berkala selama tidak sedang di dalam panggilan.
const REFRESH_MS = 20_000

const route = useRoute()
const toast = useToast()
const now = useNow()
const call = useBriefingCall()

const items = ref([])
const canHost = ref(false)
const roleOptions = ref([])
const siteOptions = ref([])
const loaded = ref(false)
const current = ref(null) // briefing yang sedang diikuti
let refreshTimer = null

const startOpen = ref(false)
const starting = ref(false)
const form = ref({ title: '', roles: ['staff_viewer'], sites: [] })
const confirmEndOpen = ref(false)
const ending = ref(false)

const roleLabel = (value) => roleOptions.value.find((role) => role.value === value)?.label ?? value

async function load() {
    try {
        const { data } = await api.get('/briefings')
        items.value = data.data.items
        canHost.value = data.data.can_host
        roleOptions.value = data.data.roles
        siteOptions.value = data.data.sites
        loaded.value = true
    } catch (err) {
        toast.error('Gagal memuat briefing', err.response?.data?.message)
    }
}

function openStart() {
    form.value = { title: '', roles: ['staff_viewer'], sites: siteOptions.value.map((site) => site.id) }
    startOpen.value = true
}

function toggleIn(list, value) {
    const index = list.indexOf(value)
    if (index >= 0) list.splice(index, 1)
    else list.push(value)
}

async function startBriefing() {
    if (!form.value.roles.length) return toast.error('Pilih peran', 'Minimal satu peran harus diundang.')
    starting.value = true
    try {
        const allSites = form.value.sites.length === siteOptions.value.length
        const { data } = await api.post('/briefings', {
            title: form.value.title,
            roles: form.value.roles,
            organization_ids: allSites ? [] : form.value.sites,
        })
        startOpen.value = false
        await enter(data.data, true)
    } catch (err) {
        toast.error('Gagal memulai briefing', err.response?.data?.message ?? err.message)
    } finally {
        starting.value = false
    }
}

async function joinBriefing(briefing) {
    try {
        const { data } = await api.post(`/briefings/${briefing.id}/join`)
        await enter(data.data, data.data.briefing.is_host)
    } catch (err) {
        toast.error('Gagal bergabung', err.response?.data?.message ?? err.message)
        load()
    }
}

async function enter(connection, asHost) {
    current.value = connection.briefing
    try {
        await call.join(connection, { asHost })
    } catch (err) {
        current.value = null
        throw err
    }
}

async function leaveBriefing() {
    await call.leave()
    current.value = null
    load()
}

async function endBriefing() {
    ending.value = true
    try {
        await api.post(`/briefings/${current.value.id}/end`)
        await call.leave()
        current.value = null
        toast.success('Briefing diakhiri', 'Semua peserta sudah dikeluarkan.')
        load()
    } catch (err) {
        toast.error('Gagal mengakhiri briefing', err.response?.data?.message)
    } finally {
        ending.value = false
        confirmEndOpen.value = false
    }
}

async function runToggle(action, failTitle) {
    try {
        await action()
    } catch (err) {
        toast.error(failTitle, err.message)
    }
}

// Pemimpin mengakhiri briefing -> room dihapus server.
watch(
    () => call.endedByHost.value,
    (ended) => {
        if (!ended || !current.value) return
        toast.info('Briefing selesai', 'Pemimpin mengakhiri briefing.')
        current.value = null
        load()
    },
)

const inCall = computed(() => !!call.room.value)
const isHost = computed(() => !!current.value?.is_host)
const gridClass = computed(() => {
    const count = call.participants.value.length
    if (count <= 1) return 'grid-cols-1 max-w-3xl mx-auto'
    if (count <= 4) return 'grid-cols-1 sm:grid-cols-2'
    if (count <= 9) return 'grid-cols-2 lg:grid-cols-3'
    return 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4'
})

onMounted(async () => {
    await load()
    // Tautan "Gabung" dari banner: /briefing?join=ID
    const joinId = Number(route.query.join)
    const target = items.value.find((briefing) => briefing.id === joinId)
    if (target) joinBriefing(target)
    refreshTimer = setInterval(() => {
        if (!inCall.value) load()
    }, REFRESH_MS)
})
onBeforeUnmount(() => clearInterval(refreshTimer))
</script>

<template>
    <div>
        <!-- ===== Di dalam panggilan ===== -->
        <div v-if="inCall" class="flex min-h-[calc(100dvh-5.5rem)] flex-col px-4 pt-5 pb-4 sm:px-8">
            <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div class="min-w-0">
                    <p class="eyebrow flex items-center gap-2">
                        <span class="beacon" />
                        Briefing berlangsung
                    </p>
                    <h1 class="truncate font-display text-2xl font-extrabold tracking-[-0.03em] text-base-50">{{ current?.title }}</h1>
                </div>
                <span
                    class="inline-flex items-center gap-2 rounded-full bg-base-900 px-3 py-1.5 text-sm font-semibold text-base-300 shadow-(--shadow-card)"
                >
                    <Users class="size-4" />
                    {{ call.participants.value.length }} peserta
                </span>
            </div>

            <!-- Presentasi (layar pemimpin) besar, peserta di sampingnya -->
            <div v-if="call.screenShare.value" class="grid flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <div class="overflow-hidden rounded-2xl bg-black">
                    <LiveVideoTile
                        :track="call.screenShare.value.track"
                        :label="`Layar ${call.screenShare.value.participant.name}`"
                        fit="contain"
                        bare
                        class="!rounded-none !border-0"
                    />
                </div>
                <div class="grid content-start gap-2 overflow-y-auto sm:grid-cols-3 lg:grid-cols-1">
                    <div
                        v-for="participant in call.participants.value"
                        :key="participant.identity"
                        class="relative aspect-video overflow-hidden rounded-xl bg-[#0e1520]"
                        :class="participant.isSpeaking && 'ring-2 ring-accent-500'"
                    >
                        <LiveVideoTile
                            v-if="call.cameraOf(participant)"
                            :track="call.cameraOf(participant)"
                            :label="participant.name || participant.identity"
                            :mirrored="participant === call.room.value.localParticipant"
                            bare
                            class="!rounded-none !border-0"
                        />
                        <span class="absolute bottom-1.5 left-2 truncate text-xs font-semibold text-white">{{ participant.name }}</span>
                    </div>
                </div>
            </div>

            <!-- Grid peserta -->
            <div v-else class="grid flex-1 content-start gap-3" :class="gridClass">
                <div
                    v-for="participant in call.participants.value"
                    :key="participant.identity"
                    class="relative aspect-video overflow-hidden rounded-2xl bg-[#0e1520] transition-shadow"
                    :class="participant.isSpeaking && 'ring-2 ring-accent-500 ring-offset-2 ring-offset-base-950'"
                >
                    <LiveVideoTile
                        v-if="call.cameraOf(participant)"
                        :track="call.cameraOf(participant)"
                        :label="participant.name || participant.identity"
                        :mirrored="participant === call.room.value.localParticipant"
                        bare
                        class="!rounded-none !border-0"
                    />
                    <div v-else class="flex size-full items-center justify-center">
                        <span
                            class="flex size-16 items-center justify-center rounded-full bg-white/10 font-display text-2xl font-extrabold text-white"
                        >
                            {{ (participant.name || '?').charAt(0).toUpperCase() }}
                        </span>
                    </div>
                    <div
                        class="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pt-6 pb-2"
                    >
                        <span class="truncate text-sm font-semibold text-white">
                            {{ participant.name || participant.identity }}
                            <template v-if="participant === call.room.value.localParticipant"> (Anda)</template>
                        </span>
                        <component
                            :is="call.micOn(participant) ? Mic : MicOff"
                            class="ml-auto size-4 shrink-0"
                            :class="call.micOn(participant) ? 'text-white' : 'text-white/50'"
                        />
                    </div>
                </div>
            </div>

            <!-- Dok kendali -->
            <div
                class="sticky bottom-4 mx-auto mt-5 flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-base-800 bg-base-900/90 p-2 shadow-(--shadow-raised) backdrop-blur"
                role="toolbar"
                aria-label="Kendali briefing"
            >
                <BaseButton
                    :variant="call.local.value.micOn ? 'outline' : 'primary'"
                    :aria-pressed="call.local.value.micOn"
                    @click="runToggle(call.toggleMic, 'Mikrofon belum menyala')"
                >
                    <component :is="call.local.value.micOn ? Mic : MicOff" class="size-4" />
                    {{ call.local.value.micOn ? 'Bisukan' : 'Nyalakan mikrofon' }}
                </BaseButton>
                <BaseButton
                    :variant="call.local.value.cameraOn ? 'outline' : 'primary'"
                    :aria-pressed="call.local.value.cameraOn"
                    @click="runToggle(call.toggleCamera, 'Kamera belum menyala')"
                >
                    <component :is="call.local.value.cameraOn ? VideoOff : Video" class="size-4" />
                    {{ call.local.value.cameraOn ? 'Matikan kamera' : 'Nyalakan kamera' }}
                </BaseButton>
                <BaseButton
                    v-if="isHost"
                    variant="outline"
                    :aria-pressed="call.local.value.screenOn"
                    @click="runToggle(call.toggleScreen, 'Layar belum dibagikan')"
                >
                    <component :is="call.local.value.screenOn ? MonitorX : MonitorUp" class="size-4" />
                    {{ call.local.value.screenOn ? 'Hentikan presentasi' : 'Presentasikan layar' }}
                </BaseButton>
                <BaseButton variant="ghost" @click="leaveBriefing">
                    <PhoneOff class="size-4" />
                    Keluar
                </BaseButton>
                <BaseButton v-if="isHost" variant="danger" @click="confirmEndOpen = true">
                    <Square class="size-4" />
                    Akhiri untuk semua
                </BaseButton>
            </div>
        </div>

        <!-- ===== Daftar briefing ===== -->
        <template v-else>
            <PageHeader
                eyebrow="Pantau"
                title="Briefing"
                subtitle="Rapat video dalam satu ruang. Pemimpin memilih peran dan site yang diundang; hanya mereka yang bisa bergabung."
            >
                <template v-if="canHost" #actions>
                    <BaseButton :loading="call.connecting.value" @click="openStart">
                        <Presentation class="size-4" />
                        Mulai briefing
                    </BaseButton>
                </template>
            </PageHeader>

            <div class="p-4 sm:p-8">
                <div v-if="!loaded" class="py-12 text-center text-sm text-base-500">Memuat briefing…</div>
                <div v-else-if="!items.length" class="rounded-2xl border border-base-800 bg-base-900 shadow-(--shadow-card)">
                    <EmptyState
                        :icon="Presentation"
                        title="Belum ada briefing yang berlangsung"
                        :description="
                            canHost
                                ? 'Tekan Mulai briefing, lalu pilih peran dan site yang diundang.'
                                : 'Briefing yang mengundang Anda muncul di sini, dan pemberitahuannya tampil di atas setiap halaman.'
                        "
                    />
                </div>
                <ul v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <li
                        v-for="briefing in items"
                        :key="briefing.id"
                        class="flex flex-col rounded-2xl border border-base-800 bg-base-900 p-5 shadow-(--shadow-card)"
                    >
                        <p class="eyebrow flex items-center gap-2">
                            <span class="beacon" />
                            Berlangsung {{ formatElapsed(briefing.started_at, now) }}
                        </p>
                        <h2 class="mt-2 font-display text-xl font-extrabold tracking-[-0.025em] text-base-50">{{ briefing.title }}</h2>
                        <p class="mt-1 text-sm text-base-400">Dipimpin {{ briefing.is_host ? 'Anda' : (briefing.host_name ?? '—') }}</p>
                        <div class="mt-3 flex flex-wrap gap-1.5">
                            <span
                                v-for="role in briefing.roles"
                                :key="role"
                                class="rounded-full bg-base-850 px-2.5 py-0.5 text-xs font-semibold text-base-300"
                                >{{ roleLabel(role) }}</span
                            >
                            <span class="rounded-full bg-copper-500/12 px-2.5 py-0.5 text-xs font-semibold text-copper-400">
                                {{ briefing.sites.length ? briefing.sites.join(', ') : 'Semua site' }}
                            </span>
                        </div>
                        <BaseButton class="mt-5" :loading="call.connecting.value" @click="joinBriefing(briefing)">
                            <Video class="size-4" />
                            Gabung
                        </BaseButton>
                    </li>
                </ul>
            </div>
        </template>

        <BaseDialog
            :open="startOpen"
            title="Mulai briefing"
            description="Hanya peran DAN site yang dicentang yang bisa bergabung. Anda masuk dengan kamera & mikrofon menyala."
            @update:open="(v) => (startOpen = v)"
        >
            <form id="briefing-form" class="space-y-5" @submit.prevent="startBriefing">
                <BaseInput v-model="form.title" label="Judul" placeholder="Contoh: Briefing pagi shift A" required maxlength="120" />
                <fieldset>
                    <legend class="field-label">Peran yang diundang</legend>
                    <div class="flex flex-wrap gap-2">
                        <label
                            v-for="role in roleOptions"
                            :key="role.value"
                            class="inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
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
                </fieldset>
                <fieldset v-if="siteOptions.length">
                    <legend class="field-label">Site yang diundang</legend>
                    <div class="flex flex-wrap gap-2">
                        <label
                            v-for="site in siteOptions"
                            :key="site.id"
                            class="inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
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
                    <p class="field-hint">Semua dicentang = semua site yang Anda pegang.</p>
                </fieldset>
            </form>
            <template #footer>
                <BaseButton variant="ghost" @click="startOpen = false">Batal</BaseButton>
                <BaseButton type="submit" form="briefing-form" :loading="starting" :disabled="!form.sites.length && siteOptions.length > 0">
                    <Presentation class="size-4" />
                    Mulai briefing
                </BaseButton>
            </template>
        </BaseDialog>

        <ConfirmDialog
            :open="confirmEndOpen"
            title="Akhiri briefing untuk semua?"
            description="Semua peserta langsung dikeluarkan dari ruang briefing."
            confirm-label="Akhiri briefing"
            :loading="ending"
            @confirm="endBriefing"
            @update:open="(v) => (confirmEndOpen = v)"
        />
    </div>
</template>
