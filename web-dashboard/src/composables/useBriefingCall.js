import { computed, ref, shallowRef } from 'vue'

import { createCameraBackground } from '@/lib/cameraBackground'
import api from '@/lib/api'

const CAMERA = 'camera'
const MICROPHONE = 'microphone'
const SCREEN = 'screen_share'
// Detak kehadiran selama di dalam ruang (daftar hadir), tiap 30 detik.
const PRESENCE_MS = 30_000

export { backgroundSupported } from '@/lib/cameraBackground'

/*
 * Satu panggilan briefing (room LiveKit briefing-{id}) yang BERTAHAN selama
 * dashboard terbuka -- state-nya di tingkat modul, bukan per komponen, jadi
 * pindah menu TIDAK memutus briefing (sama seperti siaran Live Kerja). Keluar
 * hanya lewat tombol Keluar / saat pemimpin mengakhiri. Banner "kembali ke
 * briefing" di AppShell memakai `active` untuk tahu briefing sedang berjalan.
 *
 * Peserta biasa masuk dengan kamera mati & mikrofon bisu (briefing ramai tetap
 * ringan); briefing peserta pilihan: semua masuk dengan kamera menyala.
 */
const room = shallowRef(null)
// Meta briefing yang sedang diikuti (id, title, is_host, started_at, ...).
const active = ref(null)
const revision = ref(0)
const connecting = ref(false)
const endedByHost = ref(false)
let audioContainer = null
let presenceTimer = null

const bump = () => revision.value++

// Background kamera (blur / gambar), diingat per browser.
const cameraBackground = createCameraBackground(
    'lacak.briefing.background',
    () => room.value?.localParticipant.getTrackPublication(CAMERA)?.track ?? null,
)
const applyBackground = cameraBackground.apply

async function setBackground(next) {
    await cameraBackground.set(next)
    bump()
}

const inCall = computed(() => !!room.value)

const participants = computed(() => {
    revision.value
    if (!room.value) return []
    return [room.value.localParticipant, ...room.value.remoteParticipants.values()]
})

// Layar yang sedang dibagikan, kalau ada (presenter mana pun).
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

function startPresence(briefingId) {
    stopPresence()
    const ping = () => api.post(`/briefings/${briefingId}/presence`).catch(() => {})
    ping()
    presenceTimer = setInterval(ping, PRESENCE_MS)
}

function stopPresence() {
    clearInterval(presenceTimer)
    presenceTimer = null
}

async function join(connection, { asHost }) {
    connecting.value = true
    endedByHost.value = false
    active.value = connection.briefing
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
                    stopPresence()
                    active.value = null
                    cleanup()
                }
            })

        await instance.connect(connection.livekit_url, connection.token)
        room.value = instance
        if (asHost) {
            await instance.localParticipant.enableCameraAndMicrophone().catch(() => {})
        } else if (connection.briefing.camera_on_join) {
            await instance.localParticipant.setCameraEnabled(true).catch(() => {})
        }
        startPresence(connection.briefing.id)
        bump()
    } catch (err) {
        active.value = null
        throw err
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
    cameraBackground.reset()
    audioContainer?.remove()
    audioContainer = null
    bump()
}

async function leave() {
    stopPresence()
    const instance = room.value
    active.value = null
    cleanup()
    await instance?.disconnect()
}

export function useBriefingCall() {
    return {
        room,
        active,
        inCall,
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
        background: cameraBackground.background,
        setBackground,
    }
}
