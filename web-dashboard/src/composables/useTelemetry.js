import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const REFRESH_MS = 60_000

/**
 * Angka ringkas untuk strip telemetri di AppShell: jumlah site, device per
 * status, dan staf yang sedang Live Kerja. Diambil dari endpoint yang sudah
 * di-scope backend sesuai akses user -- strip ini tidak pernah menampilkan
 * angka site yang tidak boleh dilihat user tersebut.
 */
export function useTelemetry() {
    const auth = useAuthStore()
    const summary = ref(null)
    const liveCount = ref(null)
    let timer = null

    async function refresh() {
        const [summaryResult, liveResult] = await Promise.allSettled([
            api.get('/dashboard-summary'),
            auth.hasPermission('live.watch') ? api.get('/live/sites') : Promise.resolve(null),
        ])
        if (summaryResult.status === 'fulfilled') summary.value = summaryResult.value.data.data
        if (liveResult.status === 'fulfilled' && liveResult.value) {
            liveCount.value = liveResult.value.data.data.reduce((total, site) => total + (site.live_count ?? 0), 0)
        }
    }

    onMounted(() => {
        refresh()
        timer = setInterval(refresh, REFRESH_MS)
    })
    onBeforeUnmount(() => clearInterval(timer))

    const byStatus = computed(() => summary.value?.devices_by_status ?? {})

    return {
        refresh,
        sites: computed(() => summary.value?.organizations_count ?? null),
        devicesTotal: computed(() => summary.value?.devices_count ?? null),
        devicesOnline: computed(() => (summary.value ? (byStatus.value.online ?? 0) : null)),
        devicesLocked: computed(() => (summary.value ? (byStatus.value.locked ?? 0) : null)),
        liveCount,
    }
}
