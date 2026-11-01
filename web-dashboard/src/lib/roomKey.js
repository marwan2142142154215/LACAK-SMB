// Kunci room tonton = site + peran penyiar: "3:staff_viewer", atau "pusat:leader"
// untuk Ruang pusat (penyiar yang tidak terikat site). Satu room LiveKit per
// site + peran, supaya hak tonton per peran ditegakkan server (token per room).
export const CENTRAL_SITE = 'pusat'
// Sama dengan UNKNOWN_LIVE_ROLE di backend (sesi lama tanpa peran).
export const UNKNOWN_LIVE_ROLE = 'lainnya'

/** Kunci room dari site (null = Ruang pusat) + peran. */
export const roomKey = (organizationId, role) => `${organizationId ?? CENTRAL_SITE}:${role ?? UNKNOWN_LIVE_ROLE}`

/** "3:staff_viewer" -> { organizationId: 3, role }; "pusat:leader" -> { organizationId: null, role }; selain itu null. */
export function parseRoomKey(key) {
    const match = /^(pusat|\d+):([a-z][a-z0-9_]*)$/.exec(String(key ?? ''))
    if (!match) return null
    return { organizationId: match[1] === CENTRAL_SITE ? null : Number(match[1]), role: match[2] }
}
