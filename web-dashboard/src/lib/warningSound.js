/*
 * Nada peringatan staf, dibangkitkan dengan Web Audio (tanpa file suara).
 * Browser hanya mengizinkan suara setelah user pernah berinteraksi dengan
 * halaman, jadi AudioContext dibuat & dibangunkan pada klik/tombol pertama
 * (primeWarningSound) -- dashboard staf hampir selalu sudah diklik sebelum
 * peringatan datang.
 */
let context = null

function audioContext() {
    if (!context) {
        const Context = window.AudioContext ?? window.webkitAudioContext
        if (!Context) return null
        context = new Context()
    }
    return context
}

/** Siapkan suara pada interaksi pertama user (aturan autoplay browser). */
export function primeWarningSound() {
    const wake = () => {
        audioContext()?.resume().catch(() => {})
        window.removeEventListener('pointerdown', wake)
        window.removeEventListener('keydown', wake)
    }
    window.addEventListener('pointerdown', wake)
    window.addEventListener('keydown', wake)
}

/** Dua nada naik-turun; peringatan keras diulang tiga kali dan lebih tinggi. */
export function playWarningSound(severe = false) {
    const ctx = audioContext()
    if (!ctx) return
    ctx.resume().catch(() => {})
    const notes = severe ? [988, 740] : [880, 660]
    const repeats = severe ? 3 : 2
    let at = ctx.currentTime + 0.05
    for (let round = 0; round < repeats; round++) {
        for (const frequency of notes) {
            const oscillator = ctx.createOscillator()
            const gain = ctx.createGain()
            oscillator.type = 'triangle'
            oscillator.frequency.value = frequency
            gain.gain.setValueAtTime(0.0001, at)
            gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02)
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
            oscillator.connect(gain).connect(ctx.destination)
            oscillator.start(at)
            oscillator.stop(at + 0.24)
            at += 0.24
        }
        at += 0.18
    }
}
