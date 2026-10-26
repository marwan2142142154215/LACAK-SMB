import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'

const CAMERA = 'camera'
const MICROPHONE = 'microphone'
const SCREEN = 'screen_share'

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

    const bump = () => revision.value++

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
    }
}
