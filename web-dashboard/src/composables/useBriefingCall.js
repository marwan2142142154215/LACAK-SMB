import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'

const CAMERA = 'camera'
const MICROPHONE = 'microphone'
const SCREEN = 'screen_share'

// Background kamera (hanya briefing; Live Kerja selalu kamera asli). Diproses
// di browser peserta sendiri lewat @livekit/track-processors -- yang dikirim
// ke peserta lain sudah berupa video dengan background diganti.
const BACKGROUND_KEY = 'lacak.briefing.background'
const SEGMENTER_MODEL = '/models/selfie_segmenter.tflite'
const BLUR_RADIUS = 12

function loadBackground() {
    try {
        const saved = JSON.parse(localStorage.getItem(BACKGROUND_KEY))
        if (saved?.mode === 'blur' || (saved?.mode === 'image' && saved.image)) return saved
    } catch {
        // Penyimpanan browser tidak bisa dibaca: pakai kamera asli.
    }
    return { mode: 'none', image: null }
}

function saveBackground(value) {
    try {
        localStorage.setItem(BACKGROUND_KEY, JSON.stringify(value))
    } catch {
        // Gambar terlalu besar / penyimpanan diblokir: tetap berlaku untuk sesi ini.
    }
}

/** Browser ini sanggup mengganti background? (butuh WebGL + insertable streams / OffscreenCanvas) */
export async function backgroundSupported() {
    try {
        const { supportsBackgroundProcessors } = await import('@livekit/track-processors')
        return supportsBackgroundProcessors()
    } catch {
        return false
    }
}

/**
 * Satu panggilan briefing (room LiveKit briefing-{id}). Dipakai BriefingView;
 * terputus otomatis saat halaman ditinggalkan. Peserta biasa masuk dengan
 * kamera mati & mikrofon bisu -- briefing ramai (sampai ratusan staf) tetap
 * ringan; pemimpin masuk dengan kamera & mikrofon menyala. Briefing dengan
 * peserta pilihan (rapat kecil): semua masuk dengan kamera menyala supaya
 * saling melihat.
 */
export function useBriefingCall() {
    const room = shallowRef(null)
    const revision = ref(0)
    const connecting = ref(false)
    const endedByHost = ref(false)
    let audioContainer = null
    const background = ref(loadBackground())
    let processor = null

    const bump = () => revision.value++

    /** Pasang pilihan background ke track kamera lokal (kalau kamera menyala). */
    async function applyBackground() {
        const track = room.value?.localParticipant.getTrackPublication(CAMERA)?.track
        if (!track) return
        const { mode, image } = background.value
        if (mode === 'none') {
            if (track.getProcessor()) await track.stopProcessor()
            processor = null
            return
        }
        const options =
            mode === 'blur' ? { mode: 'background-blur', blurRadius: BLUR_RADIUS } : { mode: 'virtual-background', imagePath: image }
        if (processor && track.getProcessor() === processor) {
            await processor.switchTo(options)
            return
        }
        const { BackgroundProcessor } = await import('@livekit/track-processors')
        processor = BackgroundProcessor({ ...options, assetPaths: { modelAssetPath: SEGMENTER_MODEL } })
        await track.setProcessor(processor)
    }

    async function setBackground(next) {
        background.value = next
        saveBackground(next)
        await applyBackground()
        bump()
    }

    const participants = computed(() => {
        revision.value
        if (!room.value) return []
        return [room.value.localParticipant, ...room.value.remoteParticipants.values()]
    })

    // Layar yang sedang dibagikan (presentasi pemimpin), kalau ada.
    const screenShare = computed(() => {
        revision.value
        for (const participant of participants.value) {
            const track = participant.getTrackPublication(SCREEN)?.track
            if (track && !track.isMuted) return { participant, track }
        }
        return null
    })

    const local = computed(() => {
        revision.value
        const participant = room.value?.localParticipant
        return {
            micOn: !!participant?.isMicrophoneEnabled,
            cameraOn: !!participant?.isCameraEnabled,
            screenOn: !!participant?.isScreenShareEnabled,
        }
    })

    function cameraOf(participant) {
        revision.value
        const publication = participant.getTrackPublication(CAMERA)
        return publication?.track && !publication.isMuted ? publication.track : null
    }

    function micOn(participant) {
        revision.value
        const publication = participant.getTrackPublication(MICROPHONE)
        return !!publication && !publication.isMuted
    }

    async function join({ livekit_url: url, token }, { asHost, cameraOn = asHost }) {
        connecting.value = true
        endedByHost.value = false
        try {
            const { Room, RoomEvent } = await import('livekit-client')
            const instance = new Room({ adaptiveStream: true, dynacast: true })
            const events = [
                RoomEvent.ParticipantConnected,
                RoomEvent.ParticipantDisconnected,
                RoomEvent.TrackPublished,
                RoomEvent.TrackUnpublished,
                RoomEvent.TrackMuted,
                RoomEvent.TrackUnmuted,
                RoomEvent.LocalTrackPublished,
                RoomEvent.LocalTrackUnpublished,
                RoomEvent.ActiveSpeakersChanged,
            ]
            events.forEach((event) => instance.on(event, bump))
            instance
                .on(RoomEvent.TrackSubscribed, (track) => {
                    if (track.kind === 'audio') playAudio(track)
                    bump()
                })
                .on(RoomEvent.TrackUnsubscribed, (track) => {
                    if (track.kind === 'audio') track.detach().forEach((element) => element.remove())
                    bump()
                })
                .on(RoomEvent.LocalTrackPublished, (publication) => {
                    // Kamera dinyalakan ulang = track baru: pasang lagi background-nya.
                    if (publication.source === CAMERA) applyBackground().catch(() => {})
                })
                .on(RoomEvent.Disconnected, () => {
                    // Room dihapus server = pemimpin mengakhiri briefing.
                    if (room.value === instance) {
                        endedByHost.value = true
                        cleanup()
                    }
                })

            await instance.connect(url, token)
            room.value = instance
            if (asHost) {
                await instance.localParticipant.enableCameraAndMicrophone().catch(() => {})
            } else if (cameraOn) {
                await instance.localParticipant.setCameraEnabled(true).catch(() => {})
            }
            bump()
        } finally {
            connecting.value = false
        }
    }

    function playAudio(track) {
        if (!audioContainer) {
            audioContainer = document.createElement('div')
            audioContainer.hidden = true
            document.body.append(audioContainer)
        }
        audioContainer.append(track.attach())
    }

    async function toggleMic() {
        const participant = room.value?.localParticipant
        if (participant) await participant.setMicrophoneEnabled(!participant.isMicrophoneEnabled)
        bump()
    }

    async function toggleCamera() {
        const participant = room.value?.localParticipant
        if (participant) await participant.setCameraEnabled(!participant.isCameraEnabled)
        bump()
    }

    async function toggleScreen() {
        const participant = room.value?.localParticipant
        if (participant) await participant.setScreenShareEnabled(!participant.isScreenShareEnabled)
        bump()
    }

    function cleanup() {
        room.value = null
        processor = null
        audioContainer?.remove()
        audioContainer = null
        bump()
    }

    async function leave() {
        const instance = room.value
        cleanup()
        await instance?.disconnect()
    }

    onBeforeUnmount(leave)

    return {
        room,
        connecting,
        endedByHost,
        participants,
        screenShare,
        local,
        cameraOf,
        micOn,
        join,
        leave,
        toggleMic,
        toggleCamera,
        toggleScreen,
        background,
        setBackground,
    }
}
