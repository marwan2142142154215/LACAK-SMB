package main

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/at-wat/ebml-go/webm"
)

// vp8FrameInfo membaca header frame VP8 (RFC 6386): bit 0 byte pertama = 0 berarti keyframe;
// keyframe membawa lebar & tinggi di byte 6-9.
func vp8FrameInfo(frame []byte) (keyframe bool, width, height int) {
	if len(frame) == 0 {
		return false, 0, 0
	}
	keyframe = frame[0]&0x1 == 0
	if keyframe && len(frame) >= 10 {
		raw := uint(frame[6]) | uint(frame[7])<<8 | uint(frame[8])<<16 | uint(frame[9])<<24
		width = int(raw & 0x3fff)
		height = int((raw >> 16) & 0x3fff)
	}
	return keyframe, width, height
}

// webmVideoFile menulis satu track VP8 ke berkas WebM dengan cap waktu dari RTP (bukan nomor frame),
// jadi kecepatan putar benar walau frame rate layar berubah-ubah. Berkas baru dibuka saat keyframe pertama
// (ukuran gambar baru diketahui di situ).
type webmVideoFile struct {
	path   string
	file   *os.File
	writer webm.BlockWriteCloser

	firstTimestamp uint32
	hasFirst       bool
	lastMillis     int64
	frames         int
}

func newWebmVideoFile(path string) *webmVideoFile {
	return &webmVideoFile{path: path}
}

// Write menerima satu frame VP8 utuh beserta cap waktu RTP-nya. Frame sebelum keyframe pertama dibuang.
// Mengembalikan true kalau frame benar-benar ditulis.
func (w *webmVideoFile) Write(frame []byte, rtpTimestamp uint32, clockRate uint32) (bool, error) {
	keyframe, width, height := vp8FrameInfo(frame)

	if w.writer == nil {
		if !keyframe || width == 0 || height == 0 {
			return false, nil
		}
		if err := w.open(width, height); err != nil {
			return false, err
		}
	}

	if !w.hasFirst {
		w.firstTimestamp = rtpTimestamp
		w.hasFirst = true
	}
	if clockRate == 0 {
		clockRate = 90000
	}
	// Selisih uint32: aman terhadap pembungkusan cap waktu RTP.
	elapsedTicks := int64(rtpTimestamp - w.firstTimestamp)
	millis := elapsedTicks * 1000 / int64(clockRate)
	if millis <= w.lastMillis && w.frames > 0 {
		millis = w.lastMillis + 1 // blok WebM tidak boleh mundur
	}

	if _, err := w.writer.Write(keyframe, millis, frame); err != nil {
		return false, fmt.Errorf("menulis frame: %w", err)
	}
	w.lastMillis = millis
	w.frames++
	return true, nil
}

func (w *webmVideoFile) open(width, height int) error {
	file, err := os.OpenFile(w.path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	writers, err := webm.NewSimpleBlockWriter(file, []webm.TrackEntry{
		{
			Name:            "Video",
			TrackNumber:     1,
			TrackUID:        1,
			CodecID:         "V_VP8",
			TrackType:       1,
			DefaultDuration: uint64(time.Second / 15),
			Video:           &webm.Video{PixelWidth: uint64(width), PixelHeight: uint64(height)},
		},
	})
	if err != nil {
		_ = file.Close()
		return err
	}
	if len(writers) != 1 {
		_ = file.Close()
		return errors.New("penulis WebM tidak sesuai")
	}
	w.file = file
	w.writer = writers[0]
	return nil
}

// Frames adalah jumlah frame yang tertulis; 0 berarti berkas kosong (tidak pernah ada keyframe).
func (w *webmVideoFile) Frames() int { return w.frames }

// Close menutup penulis WebM (menutup juga berkasnya).
func (w *webmVideoFile) Close() error {
	if w.writer == nil {
		return nil
	}
	err := w.writer.Close()
	w.writer = nil
	return err
}
