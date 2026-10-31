package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"

	"github.com/livekit/server-sdk-go/v2/pkg/samplebuilder"
)

const (
	// Paket video yang boleh terlambat sebelum frame dibuang (≈2 detik untuk video Full HD).
	maxVideoLate = 1000
	// Selama belum ada keyframe, minta keyframe baru paling sering sekali per interval ini.
	keyframeRequestEvery = 2 * time.Second
)

// S3Target adalah tujuan unggah, dikirim backend di tiap permintaan (rekorder tidak menyimpan kredensial Spaces).
type S3Target struct {
	AccessKey string `json:"access_key"`
	Secret    string `json:"secret"`
	Region    string `json:"region"`
	Endpoint  string `json:"endpoint"`
	Bucket    string `json:"bucket"`
}

// recording merekam SATU track video staf ke satu berkas WebM, lalu mengunggahnya.
type recording struct {
	id       string
	room     string
	trackSID string
	key      string // kunci objek di Spaces (sudah memuat awalan folder proyek)
	target   S3Target
	tmpPath  string

	cfg      *Config
	notifier *notifier
	log      *slog.Logger

	stop     chan struct{}
	stopOnce sync.Once
	started  sync.Once
	running  atomic.Bool // true begitu run() mulai membaca track
	done     chan struct{}
	frames   int // jumlah frame yang tertulis (diisi saat capture selesai)
}

func newRecording(cfg *Config, notifier *notifier, id, room, trackSID, key string, target S3Target) *recording {
	return &recording{
		id:       id,
		room:     room,
		trackSID: trackSID,
		key:      key,
		target:   target,
		tmpPath:  cfg.TmpDir + string(os.PathSeparator) + id + ".webm",
		cfg:      cfg,
		notifier: notifier,
		log:      slog.With("egress_id", id, "room", room, "track", trackSID),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
}

// requestStop meminta rekaman berhenti (aman dipanggil berkali-kali dari goroutine mana pun).
func (r *recording) requestStop() {
	r.stopOnce.Do(func() { close(r.stop) })
}

// run menjalankan rekaman sampai dihentikan atau track berakhir. Hanya dijalankan satu kali.
func (r *recording) run(track *webrtc.TrackRemote, requestKeyframe func(webrtc.SSRC)) {
	ran := false
	r.started.Do(func() { ran = true })
	if !ran {
		return
	}
	r.running.Store(true)
	defer close(r.done)

	captureErr := r.capture(track, requestKeyframe)
	r.finalize(captureErr)
}

// capture membaca paket RTP, menyusunnya jadi frame VP8, dan menulisnya ke berkas.
func (r *recording) capture(track *webrtc.TrackRemote, requestKeyframe func(webrtc.SSRC)) (result error) {
	codec := track.Codec()
	if !strings.EqualFold(codec.MimeType, webrtc.MimeTypeVP8) {
		return fmt.Errorf("codec %s belum didukung (hanya VP8)", codec.MimeType)
	}

	if err := os.MkdirAll(r.cfg.TmpDir, 0o700); err != nil {
		return fmt.Errorf("membuat folder sementara: %w", err)
	}

	file := newWebmVideoFile(r.tmpPath)
	defer func() {
		if err := file.Close(); err != nil && result == nil {
			result = fmt.Errorf("menutup berkas: %w", err)
		}
		if file.Frames() == 0 && result == nil {
			result = errors.New("tidak ada frame yang berhasil direkam (keyframe tidak diterima)")
		}
		r.frames = file.Frames()
	}()

	builder := samplebuilder.New(maxVideoLate, &codecs.VP8Packet{}, codec.ClockRate,
		samplebuilder.WithPacketDroppedHandler(func() { requestKeyframe(track.SSRC()) }))

	deadline := time.Now().Add(r.cfg.MaxSegment)
	lastKeyframeRequest := time.Time{}
	requestKeyframe(track.SSRC())
	lastKeyframeRequest = time.Now()

	for {
		select {
		case <-r.stop:
			return nil
		default:
		}
		if time.Now().After(deadline) {
			r.log.Warn("segmen mencapai batas keras, dihentikan", "max", r.cfg.MaxSegment)
			return nil
		}

		// Batas baca pendek supaya permintaan berhenti terdeteksi walau staf berhenti mengirim.
		_ = track.SetReadDeadline(time.Now().Add(time.Second))
		packet, _, err := track.ReadRTP()
		if err != nil {
			// Layar yang diam bisa tidak mengirim paket beberapa detik: batas waktu baca BUKAN akhir rekaman.
			if isReadTimeout(err) {
				continue
			}
			if isTrackEnded(err) {
				return nil // track berakhir normal (staf berhenti siaran)
			}
			return fmt.Errorf("membaca RTP: %w", err)
		}

		builder.Push(packet)
		for {
			sample, timestamp := builder.PopWithTimestamp()
			if sample == nil {
				break
			}
			written, werr := file.Write(sample.Data, timestamp, codec.ClockRate)
			if werr != nil {
				return werr
			}
			// Belum ada keyframe: terus minta sampai dapat.
			if !written && file.Frames() == 0 && time.Since(lastKeyframeRequest) >= keyframeRequestEvery {
				requestKeyframe(track.SSRC())
				lastKeyframeRequest = time.Now()
			}
		}
	}
}

// isReadTimeout mengenali galat "batas waktu baca terlewati" dari SetReadDeadline, apa pun bentuk bungkusnya.
func isReadTimeout(err error) bool {
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "deadline") || strings.Contains(text, "i/o timeout")
}

// isTrackEnded mengenali akhir aliran yang wajar (track ditutup).
func isTrackEnded(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, net.ErrClosed) {
		return true
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "closed") || strings.Contains(text, "eof")
}

// finalize memperbaiki berkas (opsional), melaporkan hasil ke backend SEGERA, lalu mengunggah.
//
// Laporan "selesai" dikirim sebelum unggahan supaya pemotongan per jam tidak punya celah: backend
// langsung memulai rekaman berikutnya begitu menerimanya. Kalau unggahan gagal, laporan kedua
// (gagal) menimpa status berkas itu.
func (r *recording) finalize(captureErr error) {
	defer func() { _ = os.Remove(r.tmpPath) }()

	if captureErr != nil {
		r.log.Warn("rekaman berakhir dengan galat", "err", captureErr)
		if r.frames == 0 {
			r.notifier.ended(r.id, r.key, 0, captureErr.Error())
			return
		}
		// Ada sebagian frame: tetap simpan apa yang ada, galatnya dicatat di laporan kedua bila unggahan gagal.
	}

	path := r.tmpPath
	if fixed, err := r.remux(); err != nil {
		r.log.Warn("ffmpeg gagal, berkas dipakai apa adanya", "err", err)
	} else if fixed != "" {
		defer func() { _ = os.Remove(fixed) }()
		path = fixed
	}

	info, err := os.Stat(path)
	if err != nil {
		r.notifier.ended(r.id, r.key, 0, fmt.Sprintf("berkas hilang: %v", err))
		return
	}

	r.notifier.ended(r.id, r.key, info.Size(), "")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	if err := uploadFile(ctx, r.target, r.key, path); err != nil {
		r.log.Error("unggah ke Spaces gagal", "err", err)
		r.notifier.ended(r.id, r.key, 0, fmt.Sprintf("unggah gagal: %v", err))
		return
	}
	r.log.Info("rekaman tersimpan", "bytes", info.Size(), "key", r.key)
}

// remux menyalin aliran ke WebM baru dengan ffmpeg (-c copy, hampir tanpa CPU) agar durasi & indeks
// pencarian ada. Mengembalikan "" kalau ffmpeg tidak diaktifkan.
func (r *recording) remux() (string, error) {
	if r.cfg.FFmpeg == "" {
		return "", nil
	}
	binary := r.cfg.FFmpeg
	if binary == "auto" {
		found, err := exec.LookPath("ffmpeg")
		if err != nil {
			return "", nil
		}
		binary = found
	}
	output := strings.TrimSuffix(r.tmpPath, ".webm") + ".fixed.webm"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, binary, "-y", "-loglevel", "error", "-i", r.tmpPath, "-c", "copy", output)
	if combined, err := command.CombinedOutput(); err != nil {
		_ = os.Remove(output)
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(string(combined)))
	}
	return output, nil
}
