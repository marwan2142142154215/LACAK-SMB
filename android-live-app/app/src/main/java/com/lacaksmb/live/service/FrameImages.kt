package com.lacaksmb.live.service

import com.google.mlkit.vision.common.InputImage
import livekit.org.webrtc.VideoFrame

/**
 * Frame kamera WebRTC (I420) -> InputImage NV21 untuk ML Kit, dengan rotasi
 * frame. Datanya disalin, jadi frame boleh dilepas setelah ini. Dipakai cek
 * wajah (FaceWatch) dan pemisah orang/latar (BackgroundProcessor).
 */
internal fun VideoFrame.toNv21InputImage(): InputImage {
    val i420 = buffer.toI420() ?: throw IllegalStateException("frame kosong")
    try {
        val width = i420.width
        val height = i420.height
        val nv21 = ByteArray(width * height * 3 / 2)
        val y = i420.dataY
        for (row in 0 until height) {
            y.position(row * i420.strideY)
            y.get(nv21, row * width, width)
        }
        val u = i420.dataU
        val v = i420.dataV
        var out = width * height
        val chromaHeight = (height + 1) / 2
        val chromaWidth = (width + 1) / 2
        for (row in 0 until chromaHeight) {
            for (col in 0 until chromaWidth) {
                if (out + 1 >= nv21.size) break
                nv21[out++] = v.get(row * i420.strideV + col)
                nv21[out++] = u.get(row * i420.strideU + col)
            }
        }
        return InputImage.fromByteArray(nv21, width, height, rotation, InputImage.IMAGE_FORMAT_NV21)
    } finally {
        i420.release()
    }
}
