import { computed, ref } from 'vue'

/**
 * Tombol "Pasang aplikasi" untuk PWA. Chrome/Edge Android memberi event beforeinstallprompt;
 * Safari iPhone tidak punya, jadi yang tampil petunjuk Bagikan -> Tambah ke Layar Utama.
 */
const deferredPrompt = ref(null)
const installed = ref(false)

const standalone = () =>
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true)

if (typeof window !== 'undefined') {
    installed.value = standalone()
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault()
        deferredPrompt.value = event
    })
    window.addEventListener('appinstalled', () => {
        installed.value = true
        deferredPrompt.value = null
    })
}

const isIos = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent)

export function usePwaInstall() {
    const canPrompt = computed(() => !installed.value && !!deferredPrompt.value)
    const showIosHint = computed(() => !installed.value && isIos)

    async function install() {
        const prompt = deferredPrompt.value
        if (!prompt) return
        deferredPrompt.value = null
        prompt.prompt()
        const choice = await prompt.userChoice.catch(() => null)
        if (choice?.outcome === 'accepted') installed.value = true
    }

    return { canPrompt, showIosHint, install }
}
