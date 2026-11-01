<script setup>
import {
    ArrowLeftRight,
    ChevronLeft,
    ChevronRight,
    Coffee,
    Maximize,
    Mic,
    MicOff,
    Minimize,
    MonitorUp,
    MonitorX,
    Network,
    Play,
    RefreshCw,
    Search,
    SlidersHorizontal,
    Smartphone,
    Square,
    TriangleAlert,
    Video,
    VolumeX,
    Wallpaper,
    X,
} from '@lucide/vue'
import {
    DialogContent,
    DialogDescription,
    DialogOverlay,
    DialogPortal,
    DialogRoot,
    DialogTitle,
    PopoverContent,
    PopoverPortal,
    PopoverRoot,
    PopoverTrigger,
} from 'reka-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BackgroundPicker from '@/components/live/BackgroundPicker.vue'
import LiveAudioButton from '@/components/live/LiveAudioButton.vue'
import LiveMiniTile from '@/components/live/LiveMiniTile.vue'
import LiveStatusBar from '@/components/live/LiveStatusBar.vue'
import LivePairTile from '@/components/live/LivePairTile.vue'
import LoginDeviceIcon from '@/components/live/LoginDeviceIcon.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import SearchSelect from '@/components/ui/SearchSelect.vue'
import { connectErrorMessage } from '@/lib/connectError'
import BaseDialog from '@/components/ui/BaseDialog.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import WarnStaffDialog from '@/components/work/WarnStaffDialog.vue'
import { formatElapsed, useNow } from '@/composables/useNow'
import { useToast } from '@/composables/useToast'
import api from '@/lib/api'
import { LEAVE_LABELS } from '@/lib/attendance'
import { backgroundSupported } from '@/lib/cameraBackground'
import { buildWallMembers, pageCountOf, pageSlice, wantedRoomKeys } from '@/lib/liveWall'
import { ATTENTION_STATUSES, WORK_STATUS, workStatus } from '@/lib/workStatus'
import { useAuthStore } from '@/stores/auth'
import { CAMERA_SOURCE, SCREEN_SOURCE, cameraOnlyDevice, canShareScreen, canStartWorkHere, micStateOf, parseRoomKey, roomKey, useLiveStore } from '@/stores/live'

const ALL_SITES = 'all'

const auth = useAuthStore()
const live = useLiveStore()
const toast = useToast()
const now = useNow()

const sites = ref([])
// ALL_SITES = semua site yang boleh ditonton sekaligus, atau id satu site.
const selectedSiteId = ref(null)
const mySession = ref(null)
const page = ref(0)
// Disimpan identity-nya, bukan objek peserta: kalau staf itu reconnect
// (sinyal putus-sambung), LiveKit membuat objek peserta baru dan objek lama
// tidak punya track lagi -- tampilan besar harus ikut objek yang baru.
const focusedIdentity = ref(null)
const focused = computed(() => live.remoteParticipants.find((p) => p.identity === focusedIdentity.value) ?? null)

// Pemegang izin warnings.send bisa memberi peringatan ke staf yang sedang dibuka (popup di dashboard staf itu).
const canWarn = computed(() => auth.hasPermission('warnings.send'))
const seesAllSites = computed(() => auth.isSuperAdmin || auth.user?.site_scope === 'all')
const focusedStaff = computed(() => {
    if (!focused.value) return null
    const staff = [...roster.value, ...centralRoster.value].find((item) => item.participant_identity === focused.value.identity)
    if (!staff || staff.user_id === auth.user?.id) return null
    // Staf Ruang pusat tidak terikat site: server hanya menerima peringatan dari pemegang semua site.
    if (staff.organization_id === null && !seesAllSites.value) return null
    return staff
})
const warnOpen = ref(false)
const confirmStartOpen = ref(false)
const confirmEndOpen = ref(false)
// Catatan kerja yang ditulis saat Selesai kerja (tampil di Aktivitas user).
const endNote = ref('')

// Semua peran bisa Live lewat izin live.broadcast. Yang tidak terikat site siaran di
// Ruang pusat dan tetap bisa memantau site-site lain sambil siaran (dulu khusus leader).
const canBroadcast = computed(() => auth.hasPermission('live.broadcast'))
// Penyiar yang tetap memantau site lain sambil siaran: yang tidak terikat site (Ruang pusat) dan peran
// ber-cakupan "Semua site" / "site yang diberikan" (mis. auditor yang siaran di site AUDITOR). Hanya
// staf ber-cakupan site sendiri yang dikunci ke site-nya selama siaran.
const monitorsWhileBroadcasting = computed(
    () => canBroadcast.value && (!auth.user?.organization_id || ['all', 'granted'].includes(auth.user?.site_scope)),
)
// Ruang pusat (siaran tanpa site) hanya untuk pemegang live.watch-central.
const canWatchCentral = computed(() => auth.hasPermission('live.watch-central'))
const isAllSites = computed(() => selectedSiteId.value === ALL_SITES)
const siteNames = computed(() => Object.fromEntries(sites.value.map((site) => [site.id, site.name])))
const totalLive = computed(() => sites.value.reduce((total, site) => total + (site.live_count ?? 0), 0))
// Nama peran untuk label & kelompok (dari /live/overview).
const roleLabels = ref({})
const roleLabel = (role) => roleLabels.value[role] ?? role
const CENTRAL_LABEL = 'Ruang pusat'
const siteLabel = (organizationId) => (organizationId === null ? CENTRAL_LABEL : (siteNames.value[organizationId] ?? null))

/** Site & peran penyiar ini, dari room tempat ia siaran. */
const roomOf = (participant) => parseRoomKey(live.participantRooms[participant.identity])

// ---- Preferensi tampilan, diingat per browser (kebiasaan tiap penonton beda).
function readPref(key, fallback) {
    try {
        return JSON.parse(localStorage.getItem(key)) ?? fallback
    } catch {
        return fallback
    }
}

function writePref(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch {
        // mode privat / penyimpanan diblokir -- cukup tidak diingat
    }
}

const LAYOUTS = [1, 2, 4]
const savedLayout = readPref('lacak_live_layout', 4)
const layout = ref(LAYOUTS.includes(savedLayout) ? savedLayout : 4)
// false = layar di kiri, kamera di kanan (bawaan).
const swapped = ref(readPref('lacak_live_swapped', false) === true)
watch(layout, (value) => {
    writePref('lacak_live_layout', value)
    page.value = 0
})
watch(swapped, (value) => writePref('lacak_live_swapped', value))

// Porsi kamera (wajah) terhadap layar kerja. Bawaan "kecil": yang dipantau
// terutama layar kerjanya, wajah cukup sebagai bukti kehadiran.
const CAMERA_SIZES = [
    { value: 'equal', label: 'Sama besar' },
    { value: 'small', label: 'Kecil' },
    { value: 'corner', label: 'Pojok' },
]
const savedCameraSize = readPref('lacak_live_camera_size', 'small')
const cameraSize = ref(CAMERA_SIZES.some((option) => option.value === savedCameraSize) ? savedCameraSize : 'small')
watch(cameraSize, (value) => writePref('lacak_live_camera_size', value))

// Kelompokkan dinding siaran & daftar status: per site atau per peran penyiar.
const GROUPINGS = [
    { value: 'none', label: 'Tanpa' },
    { value: 'site', label: 'Per site' },
    { value: 'role', label: 'Per peran' },
]
const savedGrouping = readPref('lacak_live_grouping', 'none')
const grouping = ref(GROUPINGS.some((option) => option.value === savedGrouping) ? savedGrouping : 'none')
watch(grouping, (value) => {
    writePref('lacak_live_grouping', value)
    page.value = 0
})

// ---- Status semua staf: dimuat sekali dari /live/overview, lalu perubahan
// per staf didorong gateway lewat socket (live:status). Muat ulang penuh
// hanya sesekali sebagai pengaman (staf baru di roster, socket sempat putus).
const STATUS_RESYNC_MS = 2 * 60_000
const roster = ref([])
// Penyiar yang tidak terikat site (Ruang pusat), mis. leader.
const centralRoster = ref([])
// Room (site/pusat + peran) yang sedang berisi siaran dan boleh ditonton, dari /live/overview.
const liveRooms = ref([])
const sessionByIdentity = ref({})
let statusTimer = null
let stopLiveStatus = null

function applyLiveStatus(event) {
    const sessions = { ...sessionByIdentity.value }
    if (event.session) sessions[event.participant_identity] = event.session
    else delete sessions[event.participant_identity]
    sessionByIdentity.value = sessions

    const update = (member) =>
        member.user_id === event.user_id
            ? {
                  ...member,
                  status: event.status,
                  started_at: event.started_at,
                  ...(event.organization_id === undefined ? {} : { organization_id: event.organization_id }),
                  ...(event.live_role ? { live_role: event.live_role } : {}),
              }
            : member
    // Roster berubah -> daftar room yang diinginkan (wantedRooms) ikut dihitung ulang: penyiar yang BARU mulai
    // kerja dan kebetulan ada di halaman yang tampil, room-nya dibuka otomatis (lihat watcher di bawah).
    roster.value = roster.value.map(update)
    centralRoster.value = centralRoster.value.map(update)
}

/** Site ini sedang dipantau: "Semua site" = semua site yang boleh ditonton; Ruang pusat ikut kalau boleh. */
function inScope(organizationId) {
    if (organizationId === null) return canWatchCentral.value
    return selectedSiteId.value === ALL_SITES ? sites.value.some((site) => site.id === organizationId) : organizationId === selectedSiteId.value
}

// Status (live:status) didengarkan untuk SEMUA room site + peran tempat penyiar yang dipantau bisa
// siaran -- dari daftar penyiar (yang sudah disaring hak tonton per peran oleh server) -- walau room
// videonya baru dibuka saat ada yang live.
const statusRoomKeys = computed(() => {
    const keys = new Set()
    for (const member of [...roster.value, ...centralRoster.value]) {
        if (inScope(member.organization_id)) keys.add(roomKey(member.organization_id, member.live_role))
    }
    return [...keys]
})

watch(statusRoomKeys, (keys) => live.watchLiveStatus(keys), { immediate: true })

// Samakan room yang terbuka dengan wantedRooms (halaman yang tampil). Satu putaran pada satu waktu:
// perubahan yang datang saat sedang menyambung dijalankan lagi sesudahnya, jadi tidak saling menimpa.
let syncingRooms = false
let syncRoomsAgain = false

async function syncLazyRooms() {
    if (syncingRooms) {
        syncRoomsAgain = true
        return
    }
    syncingRooms = true
    try {
        do {
            syncRoomsAgain = false
            if (live.mode === 'idle' || live.connecting) return
            await live.addWatchRooms(wantedRooms.value.filter((key) => !live.watchedRoomKeys.includes(key)))
            if (live.connecting) continue
            // Dihitung ulang: selama menunggu sambungan di atas, halaman/saringan bisa sudah berubah.
            const wanted = wantedRooms.value
            await live.removeWatchRooms(live.watchedRoomKeys.filter((key) => !wanted.includes(key)))
        } while (syncRoomsAgain)
    } finally {
        syncingRooms = false
    }
}

async function loadStatus() {
    try {
        const response = await api.get('/live/overview')
        const data = response.data.data
        sites.value = data.sites
        roster.value = data.roster
        centralRoster.value = data.central?.roster ?? []
        liveRooms.value = data.rooms ?? []
        roleLabels.value = Object.fromEntries((data.roles ?? []).map((role) => [role.name, role.label]))
        sessionByIdentity.value = Object.fromEntries(
            [...data.items, ...(data.central?.items ?? [])].map((session) => [session.participant_identity, session]),
        )
        syncLazyRooms().catch(() => {})
    } catch {
        // Status & durasi tidak wajib -- tapi daftar site wajib ada supaya
        // video tetap bisa ditonton (mis. server belum punya /live/overview).
        if (!sites.value.length) {
            const response = await api.get('/live/sites').catch(() => null)
            sites.value = response?.data.data ?? []
        }
    }
}

// Staf baru masuk room sebelum status berkalanya termuat -> muat ulang lebih
// awal. Watcher ini terpicu di SETIAP event LiveKit (indikator bicara dst),
// dan /live/overview berat -- jadi hanya untuk identity yang belum pernah
// dicari, dan paling sering sekali per OVERVIEW_MIN_GAP_MS. Peserta tanpa
// sesi kerja (mis. sesinya baru ditutup) tidak memicu muat ulang lagi;
// statusnya ikut diperbarui lewat socket (live:status) & resync berkala.
const OVERVIEW_MIN_GAP_MS = 5_000
const requestedIdentities = new Set()
let lastEarlyLoadAt = 0
let earlyLoadTimer = null

function loadStatusSoon() {
    if (earlyLoadTimer) return
    const wait = Math.max(0, lastEarlyLoadAt + OVERVIEW_MIN_GAP_MS - Date.now())
    earlyLoadTimer = setTimeout(() => {
        earlyLoadTimer = null
        lastEarlyLoadAt = Date.now()
        loadStatus()
    }, wait)
}

watch(
    () => live.remoteParticipants.map((p) => p.identity),
    (identities) => {
        const unknown = identities.filter((id) => !(id in sessionByIdentity.value) && !requestedIdentities.has(id))
        if (!unknown.length) return
        unknown.forEach((id) => requestedIdentities.add(id))
        loadStatusSoon()
    },
)

// Cek wajah: kamera menyala tapi tidak ada wajah >= 30 detik (hanya catatan).
const faceMissingOf = (identity) => !!sessionByIdentity.value[identity]?.face_missing
// Siaran dari iPhone: kamera saja (iOS tidak bisa membagikan layar dari browser).
const cameraOnlyOf = (identity) => !!sessionByIdentity.value[identity]?.camera_only

function statusOf(participant) {
    return sessionByIdentity.value[participant.identity]?.status ?? null
}

// Kapan tiap staf mulai kerja. Kalau belum termuat, pakai waktu bergabung
// ke room LiveKit sebagai perkiraan.
function liveSince(participant) {
    return sessionByIdentity.value[participant.identity]?.started_at ?? participant.joinedAt ?? null
}

/**
 * Label kecil di ubin: site (kalau beberapa site ditonton) dan peran penyiar -- kecuali yang
 * sudah jadi judul kelompoknya.
 */
function tileLabel(participant) {
    const room = roomOf(participant)
    if (!room) return null
    const parts = []
    if (grouping.value !== 'site' && (isAllSites.value || room.organizationId === null)) parts.push(siteLabel(room.organizationId))
    if (grouping.value !== 'role') parts.push(roleLabel(room.role))
    return parts.filter(Boolean).join(' · ') || null
}

// ---- Cari & saring: berlaku untuk dinding video DAN daftar status.
const search = ref('')
const statusFilter = ref(null)

function matchesSearch(name) {
    const query = search.value.trim().toLowerCase()
    return !query || name.toLowerCase().includes(query)
}

const siteRoster = computed(() =>
    isAllSites.value ? roster.value : roster.value.filter((staff) => staff.organization_id === selectedSiteId.value),
)
// Dinding pantau: staf lain (siaran sendiri tampil di pratinjau, bukan di dinding).
const othersOnSite = computed(() => siteRoster.value.filter((staff) => staff.user_id !== auth.user?.id))
// Staf lain yang sedang live dan boleh tampil di dinding (site + Ruang pusat kalau boleh).
const liveWallRoster = computed(() =>
    [...othersOnSite.value, ...(canWatchCentral.value ? centralRoster.value.filter((m) => m.user_id !== auth.user?.id) : [])].filter(
        (member) => member.started_at,
    ),
)

const statusCounts = computed(() =>
    Object.keys(WORK_STATUS)
        .map((key) => ({ key, ...WORK_STATUS[key], count: siteRoster.value.filter((staff) => staff.status === key).length }))
        .filter((entry) => entry.count),
)

const countOf = (keys) => siteRoster.value.filter((staff) => keys.includes(staff.status)).length
const liveNow = computed(() => siteRoster.value.filter((staff) => staff.started_at).length)

// Cincin warna di ubin staf yang butuh perhatian -- terlihat dari jauh di dinding pantau.
const ATTENTION_RING = {
    alert: 'ring-2 ring-danger-500 ring-offset-2 ring-offset-base-950',
    disconnected: 'ring-2 ring-st-disconnected/70',
    screen_off: 'ring-2 ring-st-screen/70',
    camera_off: 'ring-2 ring-st-camera/70',
}
const attentionRing = (participant) => ATTENTION_RING[statusOf(participant)] ?? ''

const filteredRoster = computed(() =>
    siteRoster.value
        .filter((staff) => (!statusFilter.value || staff.status === statusFilter.value) && matchesSearch(staff.name))
        // Yang perlu perhatian di atas, lalu yang sedang live, offline paling bawah.
        .sort((a, b) => rosterRank(a.status) - rosterRank(b.status) || a.name.localeCompare(b.name)),
)

function rosterRank(status) {
    if (ATTENTION_STATUSES.includes(status)) return 0
    return status === 'offline' ? 2 : 1
}

// Daftar status dipecah per site/peran mengikuti pilihan "Kelompokkan" (urutan dalam kelompok tetap).
const rosterGroups = computed(() => {
    const groups = new Map()
    for (const staff of filteredRoster.value) {
        const group = groupOf(staff.organization_id, staff.live_role)
        if (!groups.has(group.key)) groups.set(group.key, { ...group, items: [] })
        groups.get(group.key).items.push(staff)
    }
    return [...groups.values()].sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
})

// ---- Panel Status staf: "Aktif" menyembunyikan yang offline (ratusan baris tak perlu
// digulir), "Semua" menampilkan semuanya. Diingat per browser.
const savedRosterScope = readPref('lacak_live_roster_scope', 'active')
const rosterScope = ref(savedRosterScope === 'all' ? 'all' : 'active')
watch(rosterScope, (value) => writePref('lacak_live_roster_scope', value))
const inRosterScope = (member) => rosterScope.value === 'all' || member.status !== 'offline'

// Ruang pusat ikut saringan status & pencarian yang sama dengan daftar site.
const centralMatches = computed(() =>
    canWatchCentral.value
        ? centralRoster.value
              .filter((member) => (!statusFilter.value || member.status === statusFilter.value) && matchesSearch(member.name))
              .sort((a, b) => rosterRank(a.status) - rosterRank(b.status) || a.name.localeCompare(b.name))
        : [],
)

/** Kelompok di panel: Ruang pusat dulu, lalu site/peran mengikuti pilihan "Kelompokkan". */
const panelGroups = computed(() => {
    const groups = []
    const central = centralMatches.value.filter(inRosterScope)
    if (central.length) groups.push({ key: 'central', label: CENTRAL_LABEL, items: central })
    for (const group of rosterGroups.value) {
        const items = group.items.filter(inRosterScope)
        if (!items.length) continue
        // Tanpa pengelompokan, daftar site tetap diberi judul kalau ada Ruang pusat di atasnya.
        const label = group.label ?? (groups.length ? (isAllSites.value ? 'Staf site' : siteNames.value[selectedSiteId.value]) : null)
        groups.push({ ...group, label, items })
    }
    return groups.map((group) => ({ ...group, live: group.items.filter((member) => member.started_at).length }))
})

const panelTotal = computed(() => siteRoster.value.length + (canWatchCentral.value ? centralRoster.value.length : 0))
const offlineHidden = computed(() =>
    rosterScope.value === 'active'
        ? [...filteredRoster.value, ...centralMatches.value].filter((member) => member.status === 'offline').length
        : 0,
)
const panelEmptyText = computed(() => {
    if (!panelTotal.value) return 'Belum ada staf yang terdaftar untuk Live Kerja.'
    if (offlineHidden.value) return 'Belum ada staf yang aktif.'
    return 'Tidak ada staf yang cocok dengan saringan.'
})

/** Baris kedua di panel (kiri): peran & site, kecuali yang sudah jadi judul kelompoknya. */
function rosterMeta(member) {
    const parts = []
    // Kelompok Ruang pusat bukan kelompok peran: perannya tetap ditulis.
    if (grouping.value !== 'role' || member.organization_id === null) parts.push(roleLabel(member.live_role))
    if (grouping.value !== 'site' && isAllSites.value && member.organization_id !== null) parts.push(siteNames.value[member.organization_id])
    const text = parts.filter(Boolean).join(' · ')
    if (text) return text
    return member.started_at ? 'Sedang siaran' : 'Belum mulai kerja'
}

/** Baris kedua di panel (kanan): lama siaran, izin hari ini, atau tanda kosong. */
function rosterTime(member) {
    if (member.started_at) return formatElapsed(member.started_at, now.value)
    if (member.leave) return LEAVE_LABELS[member.leave] ?? 'Izin'
    return '—'
}

// ---- Jalur video staf (UDP normal / TCP lewat VPN yang memblokir UDP).
const transportFilter = ref(null)

const transportOfIdentity = (identity) => live.transportByIdentity[identity] ?? null

function transportOf(participant) {
    return transportOfIdentity(participant.identity)
}

const transportCounts = computed(() => {
    const counts = { udp: 0, tcp: 0 }
    for (const member of liveWallRoster.value) {
        const transport = transportOfIdentity(member.participant_identity)
        if (transport) counts[transport]++
    }
    return counts
})

// Siaran Ruang pusat (penyiar tanpa site) tampil di bagiannya sendiri, bukan di dinding site.
const isCentralParticipant = (participant) => roomOf(participant)?.organizationId === null
const centralParticipants = computed(() =>
    live.remoteParticipants.filter(
        (participant) =>
            isCentralParticipant(participant) &&
            matchesSearch(participant.name || participant.identity) &&
            (!statusFilter.value || statusOf(participant) === statusFilter.value) &&
            (!transportFilter.value || transportOf(participant) === transportFilter.value),
    ),
)
const centralLive = computed(() => centralRoster.value.filter((member) => member.started_at).length)

/** Kunci & judul kelompok sebuah penyiar/anggota daftar menurut pilihan "Kelompokkan". */
function groupOf(organizationId, role) {
    if (grouping.value === 'site') return { key: `site:${organizationId ?? 'pusat'}`, label: siteLabel(organizationId) ?? 'Site lain' }
    if (grouping.value === 'role') return { key: `role:${role}`, label: roleLabel(role) }
    return { key: 'all', label: null }
}

const groupOfMember = (member) => groupOf(member.organization_id, member.live_role)

// Dinding dibangun dari DAFTAR staf yang sedang live (/live/overview), bukan dari room yang sudah tersambung:
// room video baru dibuka untuk staf di halaman yang tampil (lihat wantedRooms), jadi halaman lain tidak
// mengunduh apa pun sebelum dibuka. Urutan tetap (kelompok lalu nama) supaya ubin tidak berpindah-pindah.
const wallMembers = computed(() =>
    buildWallMembers(othersOnSite.value, {
        statusFilter: statusFilter.value,
        transportFilter: transportFilter.value,
        matches: matchesSearch,
        transportOf: transportOfIdentity,
        labelOf: (member) => groupOfMember(member).label,
    }),
)

const participantByIdentity = computed(() => new Map(live.remoteParticipants.map((participant) => [participant.identity, participant])))
const participantOfMember = (member) => participantByIdentity.value.get(member.participant_identity) ?? null

// Jumlah penyiar per kelompok di seluruh dinding (bukan hanya halaman ini), untuk judul kelompok.
const groupTotals = computed(() => {
    const totals = {}
    for (const member of wallMembers.value) {
        const key = groupOfMember(member).key
        totals[key] = (totals[key] ?? 0) + 1
    }
    return totals
})

// Jumlah siaran yang tampil di dinding (site + Ruang pusat kalau boleh dilihat).
const wallLiveCount = computed(() => wallMembers.value.length + (canWatchCentral.value ? centralParticipants.value.length : 0))

// Urutan pindah staf di tampilan besar: Ruang pusat dulu, lalu halaman dinding yang tampil (ikut saringan).
const focusList = computed(() => [...centralParticipants.value, ...visibleParticipants.value])
const focusIndex = computed(() => focusList.value.findIndex((p) => p.identity === focusedIdentity.value))
const focusPosition = computed(() => (focusIndex.value >= 0 ? `${focusIndex.value + 1} dari ${focusList.value.length}` : ''))

function focusStep(direction) {
    const list = focusList.value
    if (list.length < 2) return
    const index = focusIndex.value < 0 ? 0 : (focusIndex.value + direction + list.length) % list.length
    focusedIdentity.value = list[index].identity
}

// Hanya peserta di halaman yang tampil yang di-subscribe (lihat
// live.setVisibleParticipants), jadi menonton 100+ staf tidak berarti
// mengunduh 100+ video sekaligus.
// Lebih dari 4 staf live -> semua tampil sebagai ubin kecil (klik = popup
// besar). Pilihan 1/2/4 layar hanya berlaku saat yang live 4 orang atau kurang.
const COMPACT_THRESHOLD = 4
// Maksimal staf per halaman = maksimal room yang dibuka sekaligus untuk dinding (satu room per site + peran).
const COMPACT_PAGE_SIZE = 12
const compact = computed(() => wallMembers.value.length > COMPACT_THRESHOLD)
const pageSize = computed(() => (compact.value ? COMPACT_PAGE_SIZE : layout.value))
const pageCount = computed(() => pageCountOf(wallMembers.value.length, pageSize.value))
const visibleMembers = computed(() => pageSlice(wallMembers.value, page.value, pageSize.value))
// Anggota halaman ini yang videonya sudah tersambung (sisanya muncul begitu room-nya terbuka).
const visibleParticipants = computed(() => visibleMembers.value.map(participantOfMember).filter(Boolean))
// Halaman yang tampil dipecah per kelompok (satu kelompok "all" kalau tidak dikelompokkan).
const visibleGroups = computed(() => {
    const groups = []
    for (const member of visibleMembers.value) {
        const participant = participantOfMember(member)
        const group = groupOfMember(member)
        let target = groups.at(-1)
        if (target?.key !== group.key) {
            target = { ...group, total: groupTotals.value[group.key] ?? 0, items: [], pending: [] }
            groups.push(target)
        }
        // Staf live yang videonya belum tersambung tetap tampil (kartu penanda), supaya dinding SELALU cocok
        // dengan daftar "Status staf" dan tidak ada yang hilang diam-diam.
        if (participant) target.items.push(participant)
        else target.pending.push(member)
    }
    return groups
})

// Room video yang dibuka = HANYA yang dibutuhkan halaman yang tampil, ditambah Ruang pusat dan staf yang
// sedang diperbesar. Saringan jalur (UDP/TCP) butuh semua room yang sedang ada siaran, karena jalur baru
// diketahui setelah tersambung.
const wantedRooms = computed(() =>
    wantedRoomKeys({
        visibleMembers: visibleMembers.value,
        centralMembers: canWatchCentral.value ? centralRoster.value : [],
        focusedMember: [...roster.value, ...centralRoster.value].find((member) => member.participant_identity === focusedIdentity.value),
        allRoomKeys: transportFilter.value
            ? [
                  ...new Set(
                      liveWallRoster.value
                          .filter((member) => inScope(member.organization_id))
                          .map((member) => roomKey(member.organization_id, member.live_role)),
                  ),
              ]
            : null,
    }),
)
const wantedRoomsKey = computed(() => wantedRooms.value.join('|'))
// Masih ada room halaman ini yang belum tersambung (staf yang putus dari LiveKit tidak dihitung menunggu).
const roomsPending = computed(() => wantedRooms.value.some((key) => !live.watchedRoomKeys.includes(key)))

// Pindah halaman/saringan berulang cepat tidak langsung membuka-menutup room: tunggu sebentar.
const ROOM_SYNC_DEBOUNCE_MS = 400
let roomSyncTimer = null
watch(wantedRoomsKey, () => {
    clearTimeout(roomSyncTimer)
    roomSyncTimer = setTimeout(() => syncLazyRooms().catch(() => {}), ROOM_SYNC_DEBOUNCE_MS)
})
// Perubahan yang datang saat sedang menyambung diterapkan begitu penyambungan selesai.
watch(
    () => live.connecting,
    (connecting) => {
        if (!connecting) syncLazyRooms().catch(() => {})
    },
)
const wallGridClass = computed(() => {
    if (compact.value) return 'grid-cols-2 sm:grid-cols-3 2xl:grid-cols-4'
    return layout.value === 4 ? '2xl:grid-cols-2' : 'grid-cols-1'
})
watch(compact, () => (page.value = 0))

// Video yang diunduh: halaman dinding site yang tampil + semua siaran Ruang pusat.
watch(
    [visibleParticipants, centralParticipants],
    ([participants, central]) => live.setVisibleParticipants([...participants, ...central].map((p) => p.identity)),
    { immediate: true },
)
watch(pageCount, (count) => {
    if (page.value >= count) page.value = count - 1
})
watch([search, statusFilter, transportFilter], () => (page.value = 0))

function trackOf(participant, source) {
    return participant.getTrackPublication(source)?.track ?? null
}

const isListening = (participant) => live.listening.includes(participant.identity)
// Yang didengarkan tapi sudah tidak live lagi tidak dihitung.
const listeningCount = computed(() => live.remoteParticipants.filter(isListening).length)

// ---- Cari staf yang sedang siaran: hasil muncul saat mengetik, pilih satu
// nama = siarannya dibuka di tampilan besar. Tekan "/" untuk langsung mengetik.
const SEARCH_RESULT_LIMIT = 8
const searchInput = ref(null)
const searchOpen = ref(false)
const searchActive = ref(0)

// Dicari dari daftar staf yang live (bukan dari room yang tersambung): staf di halaman lain tetap ketemu,
// dan memilihnya membuka room-nya lalu popup besarnya.
const searchResults = computed(() => {
    if (!search.value.trim()) return []
    const members = [...siteRoster.value, ...(canWatchCentral.value ? centralRoster.value : [])]
    return members
        .filter((member) => member.started_at && matchesSearch(member.name))
        .map((member) => ({
            identity: member.participant_identity,
            name: member.name,
            joinedAt: null,
            organization_id: member.organization_id,
            live_role: member.live_role,
        }))
})
const searchShown = computed(() => searchResults.value.slice(0, SEARCH_RESULT_LIMIT))
const searchSiteName = (result) =>
    [siteLabel(result.organization_id), roleLabel(result.live_role)].filter(Boolean).join(' · ') || null

watch(search, () => {
    searchActive.value = 0
    searchOpen.value = !!search.value.trim()
})

function openSearchResult(participant) {
    focusedIdentity.value = participant.identity
    searchOpen.value = false
}

function onSearchKeydown(event) {
    const count = searchShown.value.length
    if (event.key === 'Escape') {
        if (searchOpen.value) searchOpen.value = false
        else search.value = ''
        return
    }
    if (!count) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        searchOpen.value = true
        searchActive.value = (searchActive.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
    } else if (event.key === 'Enter' && searchOpen.value) {
        event.preventDefault()
        openSearchResult(searchShown.value[searchActive.value])
    }
}

function focusSearchShortcut(event) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target
    if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
    if (!searchInput.value) return
    event.preventDefault()
    searchInput.value.focus()
}

const FOCUS_TIMEOUT_MS = 15_000
let focusTimer = null
watch(focusedIdentity, (identity) => {
    clearTimeout(focusTimer)
    if (!identity) return
    focusTimer = setTimeout(() => {
        if (focusedIdentity.value !== identity || focused.value) return
        focusedIdentity.value = null
        toast.info('Siaran belum tersambung', 'Staf ini mungkin baru saja berhenti kerja atau koneksinya putus.')
    }, FOCUS_TIMEOUT_MS)
})

function focusStaff(staff) {
    // Room staf ini dibuka dulu kalau belum tersambung (wantedRooms), popup besarnya muncul setelah itu.
    if (staff.started_at) focusedIdentity.value = staff.participant_identity
}

// ---- Layar penuh untuk dinding pantau (mis. ditayangkan di monitor ruang kontrol).
const wallEl = ref(null)
const isFullscreen = ref(false)

function syncFullscreen() {
    isFullscreen.value = !!wallEl.value && document.fullscreenElement === wallEl.value
}

async function toggleFullscreen() {
    try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await wallEl.value?.requestFullscreen()
    } catch {
        toast.error('Layar penuh tidak tersedia', 'Browser ini tidak mengizinkan mode layar penuh.')
    }
}

const focusedSince = computed(() => (focused.value ? liveSince(focused.value) : null))
const ownSiteName = computed(() =>
    live.isBroadcasting && live.organizationId === null ? CENTRAL_LABEL : (siteNames.value[live.organizationId] ?? null),
)
const broadcastElapsed = computed(() => formatElapsed(live.broadcastStartedAt, now.value))
const myStatusMeta = computed(() => (live.myStatus ? workStatus(live.myStatus) : null))
// Dibaca ulang tiap detik (ikut `now`) -- kamera HP bisa menurunkan resolusi
// sendiri saat panas atau cahaya kurang.
const cameraSettings = computed(() => {
    now.value
    live.localCameraTrack
    return live.isBroadcasting ? live.localCameraSettings() : null
})

async function loadMySession() {
    const params = auth.user?.organization_id ? { organization_id: auth.user.organization_id } : {}
    const response = await api.get('/live/sessions', { params })
    mySession.value = response.data.data.my_session
}

// Opsi pemilih site: "Semua site" lalu tiap site; lencana = jumlah staf yang sedang live.
const siteOptions = computed(() => [
    { value: ALL_SITES, label: 'Semua site', badge: totalLive.value },
    ...sites.value.map((site) => ({ value: site.id, label: site.name, badge: site.live_count ?? 0 })),
])

/** Tonton satu site, atau ALL_SITES = semua site sekaligus (satu koneksi per site). */
async function selectSite(siteId) {
    // Penyiar ber-site terkunci ke site sendiri; penyiar Ruang pusat (tanpa site) tetap bisa
    // memantau site-site yang dipegangnya. Yang hanya melihat diri sendiri tidak menonton siapa pun.
    if (auth.seesOnlySelf || (live.isBroadcasting && !monitorsWhileBroadcasting.value)) return
    selectedSiteId.value = siteId
    page.value = 0
    try {
        // Hanya room untuk staf di halaman yang tampil; halaman lain dibuka saat dikunjungi (wantedRooms / syncLazyRooms).
        await live.setWatchRooms(wantedRooms.value, { allowEmpty: true })
        live.watchSelection = siteId
    } catch (err) {
        toast.error('Gagal membuka siaran', connectErrorMessage(err))
    }
}

const restartingCamera = ref(false)

async function restartCamera() {
    restartingCamera.value = true
    try {
        await live.restartCamera()
    } catch (err) {
        toast.error('Kamera gagal dinyalakan ulang', err.message)
    } finally {
        restartingCamera.value = false
    }
}

// Background kamera siaran (blur / gambar) -- hanya dari browser yang mendukung.
const canChangeBackground = ref(false)
const backgroundOpen = ref(false)
const applyingBackground = ref(false)

async function chooseBackground(value) {
    applyingBackground.value = true
    try {
        await live.setCameraBackground(value)
    } catch (err) {
        toast.error('Background belum bisa dipasang', err.message)
    } finally {
        applyingBackground.value = false
    }
}

const togglingScreen = ref(false)

async function toggleScreenShare() {
    togglingScreen.value = true
    try {
        await live.setScreenShare(!live.localScreenTrack)
    } catch (err) {
        toast.error('Layar belum dibagikan', err.message)
    } finally {
        togglingScreen.value = false
        // Laporan status dikirim ~0,4 detik setelah track berubah.
        setTimeout(loadStatus, 1000)
    }
}

const togglingMic = ref(false)

async function toggleMicrophone() {
    togglingMic.value = true
    try {
        await live.setMicrophone(live.localMicState !== 'on')
    } catch (err) {
        toast.error('Mikrofon belum menyala', err.message)
    } finally {
        togglingMic.value = false
    }
}

const togglingBreak = ref(false)

async function toggleBreak() {
    togglingBreak.value = true
    try {
        await live.setBreak(!live.onBreak)
        toast.success(
            live.onBreak ? 'Istirahat dimulai' : 'Kembali bekerja',
            live.onBreak ? 'Jam istirahat tidak dihitung sebagai jam kerja.' : null,
        )
    } finally {
        togglingBreak.value = false
        loadStatus()
    }
}

async function startWork() {
    try {
        await live.startWork()
        mySession.value = null
        loadStatus()
        if (monitorsWhileBroadcasting.value) {
            // Siarannya sendiri sudah tersambung; site-site yang dipantau ditonton lagi.
            await selectSite(selectedSiteId.value ?? ALL_SITES)
        } else {
            selectedSiteId.value = live.organizationId
        }
        toast.success(
            'Mulai kerja',
            canShareScreen ? 'Layar & kamera Anda sedang disiarkan.' : 'Kamera Anda sedang disiarkan ke atasan Anda',
        )
    } catch (err) {
        const cameraMessages = {
            NotAllowedError: 'Izin kamera ditolak. Izinkan kamera untuk situs ini di pengaturan browser, lalu coba lagi.',
            NotFoundError: 'Kamera tidak ditemukan di perangkat ini.',
            NotReadableError: 'Kamera sedang dipakai aplikasi lain (Zoom, Teams, tab lain). Tutup dulu, lalu coba lagi.',
        }
        toast.error('Gagal memulai siaran', cameraMessages[err.name] ?? err.response?.data?.message ?? err.message)
        // startWork() memutus koneksi tonton yang lama -- sambung lagi supaya
        // penonton tetap melihat siaran site walau siarannya sendiri gagal.
        // (Batal/salah pilih layar terjadi sebelum koneksi tonton diputus.)
        if (err.name !== 'ScreenShareFailed' && selectedSiteId.value) await selectSite(selectedSiteId.value)
    } finally {
        confirmStartOpen.value = false
    }
}

async function endWork() {
    try {
        await live.endWork(endNote.value.trim() || undefined)
        endNote.value = ''
        toast.success('Selesai kerja', 'Siaran kamera & layar dihentikan')
        if (selectedSiteId.value) await selectSite(selectedSiteId.value)
    } catch (err) {
        toast.error('Gagal menghentikan siaran', err.response?.data?.message)
    } finally {
        confirmEndOpen.value = false
    }
}

onMounted(async () => {
    backgroundSupported().then((supported) => (canChangeBackground.value = supported))
    document.addEventListener('fullscreenchange', syncFullscreen)
    document.addEventListener('keydown', focusSearchShortcut)
    stopLiveStatus = live.onLiveStatus(applyLiveStatus)
    statusTimer = setInterval(loadStatus, STATUS_RESYNC_MS)
    // Boleh menonton / hanya diri sendiri ditentukan izin -- pakai izin terbaru dari server,
    // bukan salinan saat login (admin bisa saja baru mengubah peran user ini).
    await auth.ensureFreshProfile()

    try {
        await loadStatus()
        if (canBroadcast.value) await loadMySession()
    } catch (err) {
        toast.error('Gagal memuat data Live Kerja', err.response?.data?.message)
        return
    }

    // Setelah refresh, siaran yang sesinya masih terbuka disambung lagi
    // otomatis (lihat live.resumeIfBroadcasting, dipicu juga oleh AppShell).
    const resume = await live.resumeIfBroadcasting()
    if (resume.resumed) mySession.value = null

    // Koneksi tetap hidup saat pindah halaman (disimpan di store) -- jangan
    // sambung ulang kalau memang sudah terhubung.
    if (live.mode !== 'idle') {
        // Pilihan terakhir diingat di store; tanpa itu (mis. sedang siaran) turunkan dari room yang terbuka.
        const watchedSites = new Set(live.watchedRoomKeys.map((key) => parseRoomKey(key)?.organizationId).filter((id) => id != null))
        selectedSiteId.value = live.watchSelection ?? (watchedSites.size > 1 ? ALL_SITES : live.organizationId)
        // Penyiar yang tetap memantau (lihat monitorsWhileBroadcasting) setelah siarannya dilanjutkan: hanya room siarannya yang
        // tersambung -- tonton lagi site-site yang dipegangnya.
        if (monitorsWhileBroadcasting.value && live.isBroadcasting && live.watchedRoomKeys.length === 1) await selectSite(ALL_SITES)
        // Pilihan tidak diketahui: jangan dibiarkan kosong, lanjut ke pilihan bawaan di bawah.
        if (selectedSiteId.value !== null) return
    }

    // Penonton multi-site langsung melihat semua staf yang live.
    if (sites.value.length > 1) {
        await selectSite(ALL_SITES)
        return
    }
    const defaultSite = sites.value.find((s) => s.id === auth.user?.organization_id) ?? sites.value[0]
    if (defaultSite) await selectSite(defaultSite.id)
})

onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', syncFullscreen)
    document.removeEventListener('keydown', focusSearchShortcut)
    clearInterval(statusTimer)
    clearTimeout(earlyLoadTimer)
    clearTimeout(roomSyncTimer)
    clearTimeout(focusTimer)
    stopLiveStatus?.()
    live.watchLiveStatus([])
})
</script>

<template>
    <div>
        <!-- Tanpa judul besar: layar ini untuk memantau, ruang vertikal dipakai video.
             Judul tetap ada untuk pembaca layar. -->
        <h1 class="sr-only">Live Kerja</h1>
        <div class="px-4 pt-5 sm:px-8 sm:pt-7">
            <LiveStatusBar
                :segments="statusCounts"
                :live="liveNow"
                :total="siteRoster.length"
                :active="statusFilter"
                @select="statusFilter = $event"
            >
                <template #actions>
                    <!-- Pemilih site: cakupan seluruh halaman, jadi diletakkan di atas, bukan di toolbar. -->
                    <SearchSelect
                        v-if="sites.length > 1 && !auth.seesOnlySelf"
                        class="w-full sm:w-64"
                        aria-label="Site yang ditonton"
                        search-placeholder="Cari site…"
                        empty-text="Tidak ada site"
                        :model-value="selectedSiteId"
                        :options="siteOptions"
                        :disabled="(live.isBroadcasting && !monitorsWhileBroadcasting) || live.connecting"
                        @update:model-value="selectSite"
                    />
                    <span
                        v-else-if="ownSiteName ?? sites[0]?.name"
                        class="rounded-lg border border-base-800 bg-base-850 px-3 py-2 text-sm font-medium text-base-100"
                        >{{ ownSiteName ?? sites[0]?.name }}</span
                    >
                    <span
                        v-if="live.isBroadcasting"
                        class="inline-flex items-center gap-2 rounded-full bg-accent-500/12 px-3 py-1.5 text-xs font-bold text-accent-400"
                    >
                        <span class="beacon" />
                        Siaran Anda · {{ myStatusMeta?.label ?? 'Aktif' }}
                    </span>
                    <BaseButton
                        v-if="canBroadcast && canStartWorkHere && !live.isBroadcasting"
                        :loading="live.connecting"
                        @click="confirmStartOpen = true"
                    >
                        <Play class="size-4" />
                        {{ mySession ? 'Lanjutkan siaran' : 'Mulai kerja' }}
                    </BaseButton>
                </template>
            </LiveStatusBar>
        </div>

        <div class="space-y-5 p-4 sm:p-8">
            <div
                v-if="live.isBroadcasting && live.cameraProblem"
                class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger-500/30 bg-danger-500/10 px-4 py-3 text-sm text-danger-400"
                role="alert"
            >
                <span class="text-pretty">{{ live.cameraProblem }}</span>
                <BaseButton size="sm" variant="outline" :loading="restartingCamera" @click="restartCamera"
                    >Nyalakan ulang kamera</BaseButton
                >
            </div>

            <div
                v-if="live.broadcastElsewhere && !live.isBroadcasting"
                class="flex items-start gap-3 rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-pretty text-warning-400"
                role="status"
            >
                <RefreshCw class="mt-0.5 size-4 shrink-0" />
                <span>
                    Siaran Anda dilanjutkan di tab atau perangkat lain dengan akun yang sama, jadi siaran di tab ini dihentikan. Tutup
                    tab ini, atau tekan Mulai kerja lagi untuk menyiarkan dari sini.
                </span>
            </div>

            <div
                v-if="live.isBroadcasting && live.reconnecting"
                class="flex items-start gap-3 rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-pretty text-warning-400"
                role="status"
            >
                <RefreshCw class="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
                <span>
                    Koneksi ke server siaran terputus, sedang menyambung ulang otomatis. Kamera dan layar tersiar lagi tanpa perlu menekan
                    apa pun.
                </span>
            </div>

            <!-- Video lewat TCP (biasanya VPN/firewall memblokir UDP): berat untuk
                 server & gambar patah-patah. Yang memperbaiki tim IT, bukan staf. -->
            <div
                v-if="live.mediaOverTcp"
                class="flex items-start gap-3 rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-pretty text-warning-400"
                role="note"
            >
                <Network class="mt-0.5 size-4 shrink-0" />
                <span>
                    Video Live Kerja di perangkat ini lewat <strong>TCP</strong>, bukan UDP, biasanya karena VPN atau firewall memblokir
                    UDP. Gambar bisa patah-patah dan server jauh lebih berat. Minta tim IT mengizinkan
                    <strong>UDP port 7882-7889</strong> ke server Live.
                </span>
            </div>

            <!-- Layar & kamera wajib: browser HP tidak bisa membagikan layar,
                 jadi kerja (siaran) hanya bisa dimulai dari komputer. -->
            <!-- iPhone: kamera saja. Safari menghentikan kamera saat aplikasi ditutup / layar dikunci. -->
            <div
                v-if="canBroadcast && cameraOnlyDevice"
                class="flex items-start gap-3 rounded-lg border border-accent-500/30 bg-accent-500/10 px-4 py-3 text-sm text-pretty text-base-200"
                role="note"
            >
                <Smartphone class="mt-0.5 size-4 shrink-0 text-accent-500" />
                <span>
                    Di iPhone, Live Kerja menyiarkan <strong>kamera saja</strong> (iPhone tidak bisa membagikan layar dari browser).
                    Biarkan aplikasi ini <strong>tetap terbuka</strong> dan layar menyala: kalau ditutup atau layar dikunci, siaran
                    terputus dan tercatat <strong>Disconnected</strong>.
                </span>
            </div>
            <div
                v-if="canBroadcast && !canStartWorkHere"
                class="flex items-start gap-3 rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-pretty text-warning-400"
                role="note"
            >
                <Smartphone class="mt-0.5 size-4 shrink-0" />
                <span>
                    Live Kerja wajib membagikan <strong>seluruh layar dan kamera</strong>, dan itu hanya bisa dari
                    <strong>komputer</strong> (Chrome atau Edge) atau APK Live Kerja di Android. Buka dashboard ini di komputer untuk
                    Mulai kerja.
                </span>
            </div>

            <div
                v-if="mySession && !live.isBroadcasting"
                class="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-pretty text-warning-400"
            >
                Sesi kerja Anda masih tercatat aktif sejak {{ new Date(mySession.started_at).toLocaleTimeString('id-ID') }}, tapi kamera
                tidak sedang menyiarkan. Tekan <strong>Lanjutkan siaran</strong>, atau sesi ditutup otomatis dalam beberapa menit.
            </div>

            <!-- Monitor siaran sendiri: layar + kamera saya, dan kendali kerja -->
            <section
                v-if="live.isBroadcasting"
                aria-label="Siaran Anda"
                class="grid gap-4 rounded-2xl border border-base-800 bg-base-900 p-3 shadow-(--shadow-card) sm:p-4 xl:grid-cols-[minmax(0,1fr)_18rem]"
            >
                <LivePairTile
                    class="self-start"
                    :name="auth.user?.name ?? 'Saya'"
                    :screen-track="live.localScreenTrack"
                    :camera-track="live.localCameraTrack"
                    :status="live.myStatus"
                    :transport="live.mediaTransport"
                    :swapped="swapped"
                    :camera-size="cameraSize"
                    mirror-camera
                />

                <aside class="flex flex-col gap-5 px-1 pb-1 xl:py-2 xl:pr-2">
                    <div>
                        <p class="eyebrow flex items-center gap-2">
                            <span class="beacon" />
                            Sedang disiarkan<template v-if="ownSiteName"> · {{ ownSiteName }}</template>
                        </p>
                        <p class="mt-2 font-display text-5xl leading-none font-extrabold tracking-[-0.045em] text-base-50 tabular-nums">
                            {{ broadcastElapsed }}
                        </p>
                        <p class="mt-1 text-xs text-base-500">lama sesi kerja</p>
                    </div>

                    <dl class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-base-800 bg-base-800 text-sm">
                        <div class="bg-base-900 px-3 py-2.5">
                            <dt class="eyebrow">Kamera</dt>
                            <dd class="mt-1 font-mono text-base-50 tabular-nums">
                                {{ cameraSettings ? `${cameraSettings.height}p · ${cameraSettings.frameRate}fps` : '—' }}
                            </dd>
                        </div>
                        <div class="bg-base-900 px-3 py-2.5">
                            <dt class="eyebrow">Layar</dt>
                            <dd class="mt-1 font-mono tabular-nums" :class="live.localScreenTrack ? 'text-base-50' : 'text-st-screen'">
                                {{ live.localScreenTrack ? 'Dibagikan' : 'Tidak' }}
                            </dd>
                        </div>
                        <div class="col-span-2 flex items-center gap-3 bg-base-900 px-3 py-2.5">
                            <div class="min-w-0 flex-1">
                                <dt class="eyebrow">Mikrofon</dt>
                                <dd
                                    class="mt-1 font-mono tabular-nums"
                                    :class="live.localMicState === 'on' ? 'text-base-50' : 'text-base-400'"
                                >
                                    {{ { on: 'Menyala', muted: 'Dibisukan', none: 'Tidak ada' }[live.localMicState] }}
                                </dd>
                            </div>
                            <BaseButton
                                :variant="live.localMicState === 'on' ? 'outline' : 'primary'"
                                size="sm"
                                :loading="togglingMic"
                                :aria-pressed="live.localMicState !== 'on'"
                                @click="toggleMicrophone"
                            >
                                <component :is="live.localMicState === 'on' ? MicOff : Mic" class="size-4" />
                                {{ live.localMicState === 'on' ? 'Bisukan' : 'Nyalakan mikrofon' }}
                            </BaseButton>
                        </div>
                    </dl>
                    <p v-if="live.micProblem" class="-mt-3 text-xs text-pretty text-warning-400">{{ live.micProblem }}</p>
                    <p
                        v-if="live.faceMissing"
                        class="-mt-2 rounded-lg bg-danger-500/10 px-3 py-2 text-xs text-pretty text-danger-400"
                        role="status"
                    >
                        Wajah Anda tidak terlihat di kamera. Tercatat sebagai <strong>Wajah hilang</strong> di log kerja sampai wajah
                        terlihat lagi.
                    </p>

                    <div class="grid gap-2">
                        <BaseButton
                            v-if="canShareScreen"
                            :variant="live.localScreenTrack ? 'outline' : 'primary'"
                            size="sm"
                            :loading="togglingScreen"
                            @click="toggleScreenShare"
                        >
                            <component :is="live.localScreenTrack ? MonitorX : MonitorUp" class="size-4" />
                            {{ live.localScreenTrack ? 'Hentikan berbagi layar' : 'Bagikan layar' }}
                        </BaseButton>
                        <p v-else class="text-xs text-pretty text-base-500">
                            Berbagi layar hanya bisa dari browser komputer (Chrome/Edge/Firefox). Dari HP, yang tersiar hanya kamera.
                        </p>
                        <BaseButton :variant="live.onBreak ? 'primary' : 'outline'" size="sm" :loading="togglingBreak" @click="toggleBreak">
                            <component :is="live.onBreak ? Play : Coffee" class="size-4" />
                            {{ live.onBreak ? 'Lanjut kerja' : 'Istirahat' }}
                        </BaseButton>
                    </div>

                    <div class="mt-auto flex flex-wrap gap-2">
                        <BaseButton variant="ghost" size="sm" :loading="restartingCamera" @click="restartCamera">
                            <RefreshCw class="size-4" />
                            Nyalakan ulang kamera
                        </BaseButton>
                        <BaseButton v-if="canChangeBackground" variant="ghost" size="sm" @click="backgroundOpen = true">
                            <Wallpaper class="size-4" />
                            Background
                        </BaseButton>
                        <BaseButton variant="danger" size="sm" :loading="live.connecting" @click="confirmEndOpen = true">
                            <Square class="size-4" />
                            Selesai kerja
                        </BaseButton>
                    </div>
                </aside>
            </section>

            <!-- Bilah kendali (satu baris): cari staf, kelompokkan, pengaturan tampilan, layar penuh -->
            <div
                v-if="!auth.seesOnlySelf"
                class="flex flex-wrap items-center gap-2 rounded-xl border border-base-800 bg-base-900 p-2 shadow-(--shadow-card)"
            >
                <div class="relative min-w-0 flex-1 basis-64 sm:max-w-sm">
                    <label for="live-search" class="sr-only">Cari staf yang sedang siaran</label>
                    <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-base-500" />
                    <input
                        id="live-search"
                        ref="searchInput"
                        v-model="search"
                        type="search"
                        role="combobox"
                        autocomplete="off"
                        placeholder="Cari nama staf yang live…"
                        class="field-control !py-2 pr-9 pl-9"
                        aria-controls="live-search-results"
                        :aria-expanded="searchOpen"
                        :aria-activedescendant="
                            searchOpen && searchShown[searchActive] ? `live-search-${searchShown[searchActive].identity}` : undefined
                        "
                        @focus="searchOpen = !!search.trim()"
                        @blur="searchOpen = false"
                        @keydown="onSearchKeydown"
                    />
                    <kbd
                        v-if="!search"
                        class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-base-700 px-1.5 font-mono text-[11px] text-base-500"
                        aria-hidden="true"
                        >/</kbd
                    >

                    <div
                        v-if="searchOpen"
                        class="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-raised)"
                    >
                        <ul
                            v-if="searchShown.length"
                            id="live-search-results"
                            role="listbox"
                            aria-label="Staf yang sedang siaran"
                            class="max-h-80 overflow-y-auto py-1"
                        >
                            <li
                                v-for="(participant, index) in searchShown"
                                :id="`live-search-${participant.identity}`"
                                :key="participant.identity"
                                role="option"
                                :aria-selected="index === searchActive"
                                class="flex cursor-pointer items-center gap-3 px-3 py-2"
                                :class="index === searchActive ? 'bg-base-850' : 'hover:bg-base-850'"
                                @mousedown.prevent="openSearchResult(participant)"
                                @mousemove="searchActive = index"
                            >
                                <span class="beacon shrink-0" />
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate text-sm font-semibold text-base-50">{{
                                        participant.name || participant.identity
                                    }}</span>
                                    <span class="block truncate text-xs text-base-500">
                                        <template v-if="searchSiteName(participant)">{{ searchSiteName(participant) }} · </template>live
                                        {{ formatElapsed(liveSince(participant), now) }}
                                    </span>
                                </span>
                                <span
                                    v-if="statusOf(participant)"
                                    class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                                    :class="workStatus(statusOf(participant)).chip"
                                    >{{ workStatus(statusOf(participant)).label }}</span
                                >
                            </li>
                        </ul>
                        <p v-else id="live-search-results" class="px-3 py-3 text-sm text-base-400">
                            Tidak ada staf live bernama “{{ search.trim() }}”.
                        </p>
                        <p
                            v-if="searchResults.length > searchShown.length"
                            class="border-t border-base-800 px-3 py-2 text-xs text-base-500"
                        >
                            {{ searchResults.length - searchShown.length }} lainnya tampil di dinding video.
                        </p>
                    </div>
                </div>


                <!-- Kelompokkan dinding & daftar status per site atau per peran penyiar. -->
                <div class="flex items-center gap-2">
                    <span class="hidden pl-1 text-xs font-medium text-base-500 md:inline">Kelompok</span>
                    <div class="segmented" role="radiogroup" aria-label="Kelompokkan siaran">
                        <button
                            v-for="option in GROUPINGS"
                            :key="option.value"
                            type="button"
                            role="radio"
                            class="segmented-item"
                            :aria-checked="grouping === option.value"
                            @click="grouping = option.value"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                </div>

                <div class="ml-auto flex items-center gap-2">
                    <!-- Video lewat TCP berat untuk server: hanya muncul kalau memang ada, klik untuk menyaring. -->
                    <button
                        v-if="transportCounts.tcp"
                        type="button"
                        class="inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold tabular-nums transition-colors"
                        :class="
                            transportFilter === 'tcp'
                                ? 'border-warning-500/50 bg-warning-500/15 text-warning-400'
                                : 'border-warning-500/30 text-warning-400 hover:bg-warning-500/10'
                        "
                        :aria-pressed="transportFilter === 'tcp'"
                        title="Video lewat TCP: UDP diblokir (biasanya VPN/firewall). Berat untuk server. Klik untuk menyaring."
                        @click="transportFilter = transportFilter === 'tcp' ? null : 'tcp'"
                    >
                        <Network class="size-3.5" />
                        TCP {{ transportCounts.tcp }}
                    </button>
                    <BaseButton v-if="listeningCount" variant="outline" size="sm" @click="live.muteAll()">
                        <VolumeX class="size-4" />
                        Bisukan semua ({{ listeningCount }})
                    </BaseButton>

                    <!-- Semua pengaturan tampilan dinding dalam satu tempat. -->
                    <PopoverRoot>
                        <PopoverTrigger as-child>
                            <BaseButton variant="outline" size="sm">
                                <SlidersHorizontal class="size-4" />
                                Tampilan
                            </BaseButton>
                        </PopoverTrigger>
                        <PopoverPortal>
                            <PopoverContent
                                align="end"
                                :side-offset="6"
                                class="z-50 w-72 space-y-4 rounded-xl border border-base-700 bg-base-900 p-4 shadow-(--shadow-raised) focus:outline-none"
                            >
                                <div>
                                    <p class="mb-2 text-xs font-semibold text-base-300">Staf per tampilan</p>
                                    <div class="segmented w-full" role="radiogroup" aria-label="Jumlah staf per tampilan">
                                        <button
                                            v-for="count in LAYOUTS"
                                            :key="count"
                                            type="button"
                                            role="radio"
                                            class="segmented-item flex-1"
                                            :aria-checked="layout === count"
                                            :disabled="compact"
                                            @click="layout = count"
                                        >
                                            {{ count }} layar
                                        </button>
                                    </div>
                                    <p v-if="compact" class="mt-1.5 text-xs text-pretty text-base-500">
                                        Lebih dari 4 staf live: semua tampil kecil. Klik staf untuk memperbesar.
                                    </p>
                                </div>
                                <div>
                                    <p class="mb-2 text-xs font-semibold text-base-300">Ukuran kamera</p>
                                    <div class="segmented w-full" role="radiogroup" aria-label="Ukuran kamera">
                                        <button
                                            v-for="option in CAMERA_SIZES"
                                            :key="option.value"
                                            type="button"
                                            role="radio"
                                            class="segmented-item flex-1"
                                            :aria-checked="cameraSize === option.value"
                                            @click="cameraSize = option.value"
                                        >
                                            {{ option.label }}
                                        </button>
                                    </div>
                                </div>
                                <div>
                                    <p class="mb-2 text-xs font-semibold text-base-300">Posisi</p>
                                    <div class="segmented w-full" role="radiogroup" aria-label="Posisi layar dan kamera">
                                        <button
                                            type="button"
                                            role="radio"
                                            class="segmented-item flex-1"
                                            :aria-checked="!swapped"
                                            @click="swapped = false"
                                        >
                                            Layar | Kamera
                                        </button>
                                        <button
                                            type="button"
                                            role="radio"
                                            class="segmented-item flex-1"
                                            :aria-checked="swapped"
                                            @click="swapped = true"
                                        >
                                            Kamera | Layar
                                        </button>
                                    </div>
                                </div>
                            </PopoverContent>
                        </PopoverPortal>
                    </PopoverRoot>

                    <BaseButton variant="outline" size="sm" title="Layar penuh" aria-label="Layar penuh" @click="toggleFullscreen">
                        <Maximize class="size-4" />
                    </BaseButton>
                </div>
            </div>

            <div class="grid items-start gap-5" :class="!auth.seesOnlySelf && 'xl:grid-cols-[minmax(0,1fr)_22rem]'">
                <!-- Dinding video (tidak ada untuk staf biasa: hanya melihat dirinya sendiri) -->
                <section
                    v-if="!auth.seesOnlySelf"
                    ref="wallEl"
                    aria-labelledby="live-wall-title"
                    :class="isFullscreen && 'overflow-auto bg-base-950 p-4'"
                >
                    <!-- Judul dinding: jumlah siaran & saringan yang sedang aktif -->
                    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
                        <h2
                            id="live-wall-title"
                            class="flex items-baseline gap-2 font-display text-lg font-bold text-base-50 tracking-[-0.015em]"
                        >
                            Sedang live
                            <span class="font-mono text-sm font-medium text-base-500 tabular-nums">{{ wallLiveCount }}</span>
                            <span v-if="isFullscreen && !isAllSites" class="text-sm font-normal text-base-500"
                                >· {{ siteNames[selectedSiteId] }}</span
                            >
                        </h2>
                        <div class="flex flex-wrap items-center gap-2">
                            <button
                                v-if="transportFilter"
                                type="button"
                                class="inline-flex items-center gap-1.5 rounded-full border border-warning-500/40 bg-warning-500/10 px-2.5 py-1 text-[12px] font-semibold text-warning-400"
                                @click="transportFilter = null"
                            >
                                Hanya video TCP
                                <X class="size-3" aria-hidden="true" />
                                <span class="sr-only">Hapus saringan jalur video</span>
                            </button>
                            <button
                                v-if="statusFilter"
                                type="button"
                                class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold"
                                :class="workStatus(statusFilter).chip"
                                @click="statusFilter = null"
                            >
                                {{ workStatus(statusFilter).label }}
                                <X class="size-3" aria-hidden="true" />
                                <span class="sr-only">Hapus saringan status</span>
                            </button>
                            <BaseButton v-if="isFullscreen" variant="outline" size="sm" @click="toggleFullscreen">
                                <Minimize class="size-4" />
                                Keluar layar penuh
                            </BaseButton>
                        </div>
                    </div>

                    <!-- Ruang pusat (siaran tanpa site, mis. leader): kelompok pertama, judul & grid sama dengan kelompok lain. -->
                    <section
                        v-if="canWatchCentral && centralParticipants.length"
                        class="mb-6"
                        aria-labelledby="live-central-title"
                    >
                        <h3 id="live-central-title" class="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-base-200">
                            Ruang pusat
                            <span class="rounded-md bg-base-850 px-1.5 py-0.5 font-mono text-[11px] font-medium text-base-400 tabular-nums">{{ centralParticipants.length }}</span>
                            <span class="text-xs font-normal text-base-500">siaran tanpa site</span>
                            <span class="h-px flex-1 bg-base-800" aria-hidden="true" />
                        </h3>
                        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
                            <div v-for="participant in centralParticipants" :key="participant.identity" class="relative">
                                <button
                                    type="button"
                                    class="tile-button block w-full rounded-xl text-left focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-none"
                                    :aria-label="`Perbesar ${participant.name || participant.identity}`"
                                    @click="focusedIdentity = participant.identity"
                                >
                                    <LiveMiniTile
                                        :name="participant.name || participant.identity"
                                        :site="roleLabel(roomOf(participant)?.role)"
                                        :screen-track="trackOf(participant, SCREEN_SOURCE)"
                                        :camera-track="trackOf(participant, CAMERA_SOURCE)"
                                        :status="statusOf(participant)"
                                        :since="liveSince(participant)"
                                        :speaking="participant.isSpeaking"
                                        :transport="transportOf(participant)"
                                    />
                                </button>
                                <LiveAudioButton
                                    class="!absolute top-1.5 right-1.5"
                                    :name="participant.name || participant.identity"
                                    :mic-state="micStateOf(participant)"
                                    :listening="isListening(participant)"
                                    :speaking="participant.isSpeaking"
                                    @toggle="live.toggleListen(participant.identity)"
                                />
                            </div>
                        </div>
                    </section>

                    <div
                        v-if="live.mode === 'idle' || !wallLiveCount"
                        class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-base-700 bg-base-900/60 px-6 py-14 text-center"
                    >
                        <span class="flex size-12 items-center justify-center rounded-xl bg-base-850 text-base-400">
                            <Video class="size-6" />
                        </span>
                        <div>
                            <p class="font-medium text-base-100">
                                <template v-if="live.mode === 'idle'">
                                    {{ live.connecting ? 'Menghubungkan ke siaran…' : 'Belum terhubung ke siaran' }}
                                </template>
                                <template v-else-if="liveNow"
                                    >Tidak ada staf live yang cocok dengan saringan</template
                                >
                                <template v-else>Belum ada staf yang mulai kerja</template>
                            </p>
                            <p v-if="!live.connecting" class="mx-auto mt-1 max-w-md text-sm text-pretty text-base-500">
                                <template v-if="live.mode === 'idle'"
                                    >Pilih site di atas untuk melihat siapa saja yang sedang bekerja.</template
                                >
                                <template v-else-if="liveNow"
                                    >Hapus pencarian atau saringan status untuk melihat semua.</template
                                >
                                <template v-else>Layar & kamera staf muncul di sini begitu mereka menekan Mulai kerja.</template>
                            </p>
                        </div>
                    </div>

                    <!-- Bingkai dibuat lebar: adaptiveStream memilih layer resolusi dari
                         ukuran video, jadi bingkai besar = gambar lebih tajam. -->
                    <!-- Tombol suara SEJAJAR (bukan di dalam) tombol perbesar: tombol
                         bersarang tidak sah di HTML dan membingungkan pembaca layar. -->
                    <template v-else>
                    <!-- Video halaman ini baru dibuka saat halamannya tampil: tunggu sebentar saat berpindah halaman. -->
                    <p
                        v-if="roomsPending && visibleParticipants.length < visibleMembers.length"
                        class="mb-3 text-xs text-base-500"
                        role="status"
                    >
                        Menyambungkan siaran halaman ini… ({{ visibleParticipants.length }}/{{ visibleMembers.length }})
                    </p>
                    <!-- Satu kelompok per site/peran (atau satu kelompok tanpa judul kalau tidak dikelompokkan). -->
                    <div v-for="group in visibleGroups" :key="group.key" :class="group.label && 'mb-6 last:mb-0'">
                    <h3 v-if="group.label" class="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-base-200">
                        {{ group.label }}
                        <span class="rounded-md bg-base-850 px-1.5 py-0.5 font-mono text-[11px] font-medium text-base-400 tabular-nums">{{ group.total }}</span>
                        <span class="h-px flex-1 bg-base-800" aria-hidden="true" />
                    </h3>
                    <TransitionGroup v-if="compact" tag="div" name="tile" class="grid gap-3" :class="wallGridClass">
                        <div
                            v-for="participant in group.items"
                            :key="participant.identity"
                            class="relative rounded-xl"
                            :class="attentionRing(participant)"
                        >
                            <button
                                type="button"
                                class="tile-button block w-full rounded-xl text-left focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-none"
                                :aria-label="`Perbesar ${participant.name || participant.identity}`"
                                @click="focusedIdentity = participant.identity"
                            >
                                <LiveMiniTile
                                    :name="participant.name || participant.identity"
                                    :site="tileLabel(participant)"
                                    :screen-track="trackOf(participant, SCREEN_SOURCE)"
                                    :camera-track="trackOf(participant, CAMERA_SOURCE)"
                                    :status="statusOf(participant)"
                                    :since="liveSince(participant)"
                                    :speaking="participant.isSpeaking"
                                    :transport="transportOf(participant)"
                                />
                            </button>
                            <LiveAudioButton
                                class="!absolute top-1.5 right-1.5"
                                :name="participant.name || participant.identity"
                                :mic-state="micStateOf(participant)"
                                :listening="isListening(participant)"
                                :speaking="participant.isSpeaking"
                                @toggle="live.toggleListen(participant.identity)"
                            />
                            <span
                                v-if="faceMissingOf(participant.identity)"
                                class="pointer-events-none !absolute top-1.5 left-1.5 rounded-full bg-danger-500 px-2 py-0.5 text-[11px] font-bold text-white shadow"
                                >Wajah hilang</span
                            >
                            <span
                                v-else-if="cameraOnlyOf(participant.identity)"
                                class="pointer-events-none !absolute top-1.5 left-1.5 rounded-full bg-base-950/80 px-2 py-0.5 text-[11px] font-bold text-white shadow"
                                title="Siaran dari iPhone: kamera saja, tanpa layar"
                                >Kamera saja · iPhone</span
                            >
                        </div>
                    </TransitionGroup>
                    <TransitionGroup v-else tag="div" name="tile" class="grid gap-4" :class="wallGridClass">
                        <div
                            v-for="participant in group.items"
                            :key="participant.identity"
                            class="relative rounded-xl"
                            :class="attentionRing(participant)"
                        >
                            <button
                                type="button"
                                class="tile-button block w-full rounded-xl text-left focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-none"
                                :aria-label="`Perbesar ${participant.name || participant.identity}`"
                                @click="focusedIdentity = participant.identity"
                            >
                                <LivePairTile
                                    :name="participant.name || participant.identity"
                                    :site="tileLabel(participant)"
                                    :screen-track="trackOf(participant, SCREEN_SOURCE)"
                                    :camera-track="trackOf(participant, CAMERA_SOURCE)"
                                    :status="statusOf(participant)"
                                    :since="liveSince(participant)"
                                    :quality="participant.connectionQuality"
                                    :transport="transportOf(participant)"
                                    :swapped="swapped"
                                    :camera-size="cameraSize"
                                    :speaking="participant.isSpeaking"
                                    action-inset
                                />
                            </button>
                            <LiveAudioButton
                                class="!absolute top-1 right-2"
                                :name="participant.name || participant.identity"
                                :mic-state="micStateOf(participant)"
                                :listening="isListening(participant)"
                                :speaking="participant.isSpeaking"
                                @toggle="live.toggleListen(participant.identity)"
                            />
                            <span
                                v-if="faceMissingOf(participant.identity)"
                                class="pointer-events-none !absolute top-1.5 left-1.5 rounded-full bg-danger-500 px-2 py-0.5 text-[11px] font-bold text-white shadow"
                                >Wajah hilang</span
                            >
                            <span
                                v-else-if="cameraOnlyOf(participant.identity)"
                                class="pointer-events-none !absolute top-1.5 left-1.5 rounded-full bg-base-950/80 px-2 py-0.5 text-[11px] font-bold text-white shadow"
                                title="Siaran dari iPhone: kamera saja, tanpa layar"
                                >Kamera saja · iPhone</span
                            >
                        </div>
                    </TransitionGroup>
                    <!-- Live menurut data, tapi videonya belum ada di room yang dibuka. -->
                    <div v-if="group.pending.length" class="grid gap-3" :class="[wallGridClass, group.items.length && 'mt-3']">
                        <div
                            v-for="member in group.pending"
                            :key="member.user_id"
                            class="flex min-h-24 flex-col justify-between gap-2 rounded-xl border border-dashed border-base-700 bg-base-900/60 p-3"
                            :title="
                                roomsPending
                                    ? 'Sedang menyambungkan video staf ini.'
                                    : 'Staf ini tercatat live, tapi siarannya belum masuk room yang bisa dilihat. Biasanya karena siaran dimulai sebelum pembaruan: minta staf menyegarkan halaman Live.'
                            "
                        >
                            <div class="flex items-start justify-between gap-2">
                                <span class="min-w-0 truncate text-sm font-semibold text-base-100">{{ member.name }}</span>
                                <span
                                    v-if="member.status"
                                    class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                                    :class="workStatus(member.status).chip"
                                    >{{ workStatus(member.status).label }}</span
                                >
                            </div>
                            <p class="text-xs text-base-500">
                                {{ roomsPending ? 'Menyambungkan video…' : 'Video belum tersambung' }}
                                <template v-if="member.started_at"> · live {{ formatElapsed(member.started_at, now) }}</template>
                            </p>
                        </div>
                    </div>
                    </div>
                    </template>

                    <div
                        v-if="pageCount > 1"
                        class="mt-4 flex items-center justify-center gap-1 font-mono text-xs text-base-400 tabular-nums"
                    >
                        <BaseButton variant="ghost" size="sm" :disabled="page === 0" aria-label="Halaman sebelumnya" @click="page--">
                            <ChevronLeft class="size-4" />
                        </BaseButton>
                        {{ page + 1 }} / {{ pageCount }}
                        <BaseButton
                            variant="ghost"
                            size="sm"
                            :disabled="page >= pageCount - 1"
                            aria-label="Halaman berikutnya"
                            @click="page++"
                        >
                            <ChevronRight class="size-4" />
                        </BaseButton>
                    </div>
                </section>

                <!-- Panel status: satu daftar bergulir, judul kelompok menempel di atas saat digulir.
                     Ruang bawah ekstra supaya baris terakhir tidak tertutup tombol chat. -->
                <aside
                    aria-labelledby="live-status-title"
                    class="flex flex-col overflow-hidden rounded-xl border border-base-800 bg-base-900 shadow-(--shadow-card) xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6.5rem)]"
                >
                    <div class="flex items-center justify-between gap-3 border-b border-base-800 px-4 py-3">
                        <h2
                            id="live-status-title"
                            class="flex items-baseline gap-2 font-display text-base font-bold text-base-50 tracking-[-0.015em]"
                        >
                            Status staf
                            <span class="font-mono text-xs font-medium text-base-500 tabular-nums">{{ panelTotal }}</span>
                        </h2>
                        <div class="segmented" role="radiogroup" aria-label="Staf yang ditampilkan">
                            <button
                                type="button"
                                role="radio"
                                class="segmented-item"
                                :aria-checked="rosterScope === 'active'"
                                title="Sembunyikan staf yang offline"
                                @click="rosterScope = 'active'"
                            >
                                Aktif
                            </button>
                            <button
                                type="button"
                                role="radio"
                                class="segmented-item"
                                :aria-checked="rosterScope === 'all'"
                                @click="rosterScope = 'all'"
                            >
                                Semua
                            </button>
                        </div>
                    </div>

                    <div v-if="!panelGroups.length" class="px-4 py-10 text-center">
                        <p class="text-sm text-base-400">{{ panelEmptyText }}</p>
                        <button
                            v-if="offlineHidden"
                            type="button"
                            class="mt-2 text-xs font-semibold text-accent-400 hover:underline"
                            @click="rosterScope = 'all'"
                        >
                            Tampilkan {{ offlineHidden }} staf offline
                        </button>
                    </div>
                    <div v-else class="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-20">
                        <section v-for="group in panelGroups" :key="group.key" :aria-label="group.label ?? 'Staf'">
                            <h3
                                v-if="group.label"
                                class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-base-800 bg-base-900/95 px-4 py-2 text-xs font-semibold text-base-300 backdrop-blur-sm"
                            >
                                <span class="truncate">{{ group.label }}</span>
                                <span class="shrink-0 font-mono text-[11px] font-medium text-base-500 tabular-nums"
                                    >{{ group.live }} live · {{ group.items.length }}</span
                                >
                            </h3>
                            <ul class="divide-y divide-base-800/70">
                                <li v-for="staff in group.items" :key="staff.user_id">
                                    <button
                                        type="button"
                                        class="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left transition-colors hover:bg-base-850 focus-visible:bg-base-850 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
                                        :disabled="!sessionByIdentity[staff.participant_identity]"
                                        @click="focusStaff(staff)"
                                    >
                                        <span
                                            class="led row-span-2"
                                            :class="[workStatus(staff.status).led, staff.status === 'alert' && 'motion-safe:animate-pulse']"
                                        />
                                        <span class="flex min-w-0 items-center gap-1.5">
                                            <span class="truncate text-sm font-medium text-base-100">{{ staff.name }}</span>
                                            <LoginDeviceIcon :device="staff.login_device" />
                                        </span>
                                        <span class="flex items-center justify-end gap-1.5">
                                            <span
                                                v-if="faceMissingOf(staff.participant_identity)"
                                                class="rounded-full bg-danger-500/12 px-1.5 py-0.5 text-[11px] font-semibold text-danger-400"
                                                title="Wajah tidak terlihat di kamera"
                                                >Wajah</span
                                            >
                                            <span
                                                v-if="staff.started_at && cameraOnlyOf(staff.participant_identity)"
                                                class="rounded-full bg-st-screen/12 px-1.5 py-0.5 text-[11px] font-semibold text-st-screen"
                                                title="Siaran dari iPhone: kamera saja, tanpa layar"
                                                >iPhone</span
                                            >
                                            <span
                                                class="min-w-[4.75rem] rounded-full border px-2 py-0.5 text-center text-[11px] font-semibold"
                                                :class="workStatus(staff.status).chip"
                                            >
                                                {{ workStatus(staff.status).label }}
                                            </span>
                                        </span>
                                        <span class="col-start-2 truncate text-xs text-base-500">{{ rosterMeta(staff) }}</span>
                                        <span
                                            class="col-start-3 justify-self-end font-mono text-[11px] tabular-nums"
                                            :class="staff.started_at ? 'text-base-300' : 'text-base-600'"
                                            >{{ rosterTime(staff) }}</span
                                        >
                                    </button>
                                </li>
                            </ul>
                        </section>
                        <button
                            v-if="offlineHidden"
                            type="button"
                            class="block w-full border-t border-base-800 px-4 py-2.5 text-left text-xs text-base-500 transition-colors hover:bg-base-850 hover:text-base-200"
                            @click="rosterScope = 'all'"
                        >
                            {{ offlineHidden }} staf offline disembunyikan ·
                            <span class="font-semibold text-accent-400">Tampilkan</span>
                        </button>
                    </div>
                </aside>
            </div>
        </div>

        <DialogRoot :open="!!focused" @update:open="(v) => !v && (focusedIdentity = null)">
            <DialogPortal>
                <DialogOverlay class="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm" />
                <DialogContent
                    @keydown.left.prevent="focusStep(-1)"
                    @keydown.right.prevent="focusStep(1)"
                    class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[min(110rem,calc((100dvh-9rem)*32/9))] -translate-x-1/2 -translate-y-1/2 overflow-auto focus:outline-none"
                >
                    <div class="mb-3 flex flex-wrap items-center justify-between gap-4">
                        <div class="flex min-w-0 items-center gap-3">
                            <div class="flex items-center gap-1">
                                <button
                                    type="button"
                                    class="flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-accent-400 disabled:opacity-30"
                                    aria-label="Staf sebelumnya"
                                    :disabled="focusList.length < 2"
                                    @click="focusStep(-1)"
                                >
                                    <ChevronLeft class="size-5" />
                                </button>
                                <button
                                    type="button"
                                    class="flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-accent-400 disabled:opacity-30"
                                    aria-label="Staf berikutnya"
                                    :disabled="focusList.length < 2"
                                    @click="focusStep(1)"
                                >
                                    <ChevronRight class="size-5" />
                                </button>
                            </div>
                            <div class="min-w-0">
                                <DialogTitle class="truncate font-display text-xl font-extrabold tracking-[-0.025em] text-white">
                                    {{ focused?.name || focused?.identity }}
                                </DialogTitle>
                                <DialogDescription class="text-xs text-white/60 tabular-nums">
                                    {{ focusPosition }} · live sejak
                                    {{ focusedSince ? new Date(focusedSince).toLocaleTimeString('id-ID') : '—' }} · ← → untuk pindah staf
                                </DialogDescription>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <LiveAudioButton
                                v-if="focused"
                                :name="focused.name || focused.identity"
                                :mic-state="micStateOf(focused)"
                                :listening="isListening(focused)"
                                :speaking="focused.isSpeaking"
                                @toggle="live.toggleListen(focused.identity)"
                            />
                            <BaseButton variant="outline" size="sm" :aria-pressed="swapped" @click="swapped = !swapped">
                                <ArrowLeftRight class="size-4" />
                                Tukar
                            </BaseButton>
                            <BaseButton v-if="canWarn && focusedStaff" variant="danger" size="sm" @click="warnOpen = true">
                                <TriangleAlert class="size-4" />
                                Beri peringatan
                            </BaseButton>
                            <button
                                type="button"
                                class="flex size-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-accent-400"
                                aria-label="Tutup"
                                @click="focusedIdentity = null"
                            >
                                <X class="size-5" />
                            </button>
                        </div>
                    </div>
                    <!-- Track yang sama terpasang di ubin grid & di sini; adaptiveStream
                         memakai elemen terbesar, jadi tampilan ini meminta layer tertinggi. -->
                    <LivePairTile
                        v-if="focused"
                        :name="focused.name || focused.identity"
                        :site="searchSiteName(focused)"
                        :screen-track="trackOf(focused, SCREEN_SOURCE)"
                        :camera-track="trackOf(focused, CAMERA_SOURCE)"
                        :status="statusOf(focused)"
                        :since="focusedSince"
                        :quality="focused.connectionQuality"
                        :transport="transportOf(focused)"
                        :swapped="swapped"
                        :camera-size="cameraSize"
                        :speaking="focused.isSpeaking"
                        large
                    />
                </DialogContent>
            </DialogPortal>
        </DialogRoot>

        <WarnStaffDialog v-model:open="warnOpen" :staff="focusedStaff" />

        <BackgroundPicker
            :open="backgroundOpen"
            :value="live.cameraBackground"
            :applying="applyingBackground"
            description="Ganti latar kamera siaran Live Kerja. Diproses di komputer Anda; atasan melihat hasilnya. Cek wajah tetap berjalan."
            @update:open="(v) => (backgroundOpen = v)"
            @select="chooseBackground"
        />

        <ConfirmDialog
            v-model:open="confirmStartOpen"
            :title="canShareScreen ? 'Mulai kerja & bagikan seluruh layar?' : 'Mulai kerja & nyalakan kamera?'"
            :description="
                canShareScreen
                    ? 'Setelah menekan Mulai kerja, pilih tab Entire screen (Seluruh layar) lalu tekan Share. Layar, kamera, dan suara mikrofon Anda disiarkan ke atasan Anda (leader, admin, dan admin site) sampai Anda menekan Selesai kerja. Mikrofon bisa Anda bisukan kapan saja. Tidak direkam. Jam mulai, istirahat, dan selesai kerja tercatat di log kerja.'
                    : 'Kamera dan suara mikrofon Anda disiarkan ke atasan Anda (leader, admin, dan admin site) sampai Anda menekan Selesai kerja. Mikrofon bisa Anda bisukan kapan saja. Tidak direkam. Jam mulai, istirahat, dan selesai kerja tercatat di log kerja.'
            "
            confirm-label="Mulai kerja"
            confirm-variant="primary"
            :loading="live.connecting"
            @confirm="startWork"
        />

        <BaseDialog
            :open="confirmEndOpen"
            title="Selesai kerja?"
            description="Siaran kamera, layar, dan mikrofon Anda dihentikan, dan jam selesai kerja dicatat."
            @update:open="(v) => (confirmEndOpen = v)"
        >
            <label class="block">
                <span class="field-label">Catatan kerja hari ini (opsional)</span>
                <textarea
                    v-model="endNote"
                    rows="4"
                    maxlength="2000"
                    class="field-control"
                    placeholder="Contoh: Input 40 faktur, follow-up 3 pelanggan, laporan stok selesai."
                />
                <span class="field-hint block">Dibaca leader di Aktivitas user.</span>
            </label>
            <template #footer>
                <BaseButton variant="ghost" @click="confirmEndOpen = false">Batal</BaseButton>
                <BaseButton variant="danger" :loading="live.connecting" @click="endWork">Selesai kerja</BaseButton>
            </template>
        </BaseDialog>
    </div>
</template>

<style scoped>
/* Ubin terangkat saat disorot -- isyarat bisa diklik untuk diperbesar */
.tile-button {
    transition:
        transform 200ms cubic-bezier(0.22, 1, 0.36, 1),
        box-shadow 200ms;
}

.tile-button:hover {
    transform: translateY(-3px);
    box-shadow: var(--shadow-raised);
}

/* Staf baru mulai kerja: ubin muncul halus, yang selesai memudar */
.tile-enter-active,
.tile-leave-active {
    transition:
        opacity 300ms,
        transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
}

.tile-enter-from,
.tile-leave-to {
    opacity: 0;
    transform: scale(0.96);
}

@media (prefers-reduced-motion: reduce) {
    .tile-button,
    .tile-enter-active,
    .tile-leave-active {
        transition: none;
    }

    .tile-button:hover {
        transform: none;
    }
}
</style>
