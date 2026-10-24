// Foto untuk chat staf: diperkecil di browser sebelum diunggah supaya
// kiriman dari kamera HP (5-12 MB) jadi ratusan KB dan cepat sampai.
// Batas & tipe sama dengan ChatMessageController (backend tetap memvalidasi).

export const CHAT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const MAX_EDGE = 1600
const JPEG_QUALITY = 0.85

/**
 * @param {File} file
 * @returns {Promise<File>} siap diunggah
 * @throws {Error} pesan berbahasa Indonesia untuk ditampilkan ke user
 */
export async function prepareChatImage(file) {
    if (!CHAT_IMAGE_TYPES.includes(file.type)) {
        throw new Error('Hanya gambar JPG, PNG, WEBP, atau GIF yang bisa dikirim.')
    }

    // GIF dibiarkan apa adanya supaya animasinya tidak hilang.
    if (file.type === 'image/gif') return ensureSize(file)

    let bitmap
    try {
        bitmap = await createImageBitmap(file)
    } catch {
        throw new Error('Gambar tidak bisa dibaca. Coba simpan ulang lalu kirim lagi.')
    }

    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    // Sudah kecil & ringan -- tidak perlu dikodekan ulang.
    if (scale === 1 && file.size <= 600 * 1024) {
        bitmap.close()
        return file
    }

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const context = canvas.getContext('2d')
    // Latar putih: PNG transparan tidak berubah hitam saat jadi JPEG.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    if (!blob) throw new Error('Gambar gagal diproses. Coba lagi.')
    const name = (file.name || 'gambar').replace(/\.[^.]+$/, '') + '.jpg'
    return ensureSize(new File([blob], name, { type: 'image/jpeg' }))
}

function ensureSize(file) {
    if (file.size > CHAT_IMAGE_MAX_BYTES) throw new Error('Gambar terlalu besar (maksimal 5 MB).')
    return file
}
