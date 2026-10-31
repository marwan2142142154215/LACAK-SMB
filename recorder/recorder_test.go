package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSignWebhookRoundTrip(t *testing.T) {
	now := time.Now()
	body := []byte(`{"event":"egress_ended"}`)
	token := signWebhook("APIkey", "secret-secret-secret-secret-1234", body, now)

	if err := verifyBearer("Bearer "+token, "APIkey", "secret-secret-secret-secret-1234", now); err != nil {
		t.Fatalf("token sah ditolak: %v", err)
	}
	if err := verifyBearer(token, "APIkey", "secret-secret-secret-secret-1234", now); err != nil {
		t.Fatalf("token tanpa awalan Bearer ditolak: %v", err)
	}

	// Klaim sha256 harus = base64(sha256(body)), persis yang dicocokkan backend.
	parts := strings.Split(token, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims map[string]any
	_ = json.Unmarshal(raw, &claims)
	digest := sha256.Sum256(body)
	if claims["sha256"] != base64.StdEncoding.EncodeToString(digest[:]) {
		t.Fatalf("klaim sha256 salah: %v", claims["sha256"])
	}
	if claims["iss"] != "APIkey" {
		t.Fatalf("iss salah: %v", claims["iss"])
	}
}

func TestVerifyBearerRejects(t *testing.T) {
	now := time.Now()
	good := signWebhook("APIkey", "secret-secret-secret-secret-1234", []byte("x"), now)

	cases := map[string]struct {
		header, key, secret string
		at                  time.Time
	}{
		"secret salah":       {good, "APIkey", "secret-lain-secret-lain-secret-12", now},
		"issuer salah":       {good, "KeyLain", "secret-secret-secret-secret-1234", now},
		"kedaluwarsa":        {good, "APIkey", "secret-secret-secret-secret-1234", now.Add(time.Hour)},
		"bukan JWT":          {"abc", "APIkey", "secret-secret-secret-secret-1234", now},
		"kosong":             {"", "APIkey", "secret-secret-secret-secret-1234", now},
		"payload diubah":     {tamper(good), "APIkey", "secret-secret-secret-secret-1234", now},
		"hanya Bearer":       {"Bearer ", "APIkey", "secret-secret-secret-secret-1234", now},
		"tiga bagian kosong": {"..", "APIkey", "secret-secret-secret-secret-1234", now},
	}
	for name, c := range cases {
		if err := verifyBearer(c.header, c.key, c.secret, c.at); err == nil {
			t.Errorf("%s: seharusnya ditolak", name)
		}
	}
}

func tamper(token string) string {
	parts := strings.Split(token, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	changed := strings.Replace(string(raw), "APIkey", "Hacker", 1)
	parts[1] = base64.RawURLEncoding.EncodeToString([]byte(changed))
	return strings.Join(parts, ".")
}

func TestIsLoopback(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:7870": true,
		"localhost:7870": true,
		"[::1]:7870":     true,
		"0.0.0.0:7870":   false,
		":7870":          false,
		"10.0.0.5:7870":  false,
		"[::]:7870":      false,
		"example.com:80": false,
	} {
		if got := isLoopback(addr); got != want {
			t.Errorf("isLoopback(%q) = %v, seharusnya %v", addr, got, want)
		}
	}
}

func TestStartRequestValidate(t *testing.T) {
	good := startRequest{
		Room:     "site-12",
		TrackSID: "TR_AMabc123",
		Key:      "lacaklive/recordings/12/5/2026-10-31/screen_share-123000-TR_AMabc123.webm",
		Target:   S3Target{AccessKey: "a", Secret: "b", Endpoint: "https://x", Bucket: "c"},
	}
	if err := good.validate(); err != nil {
		t.Fatalf("permintaan sah ditolak: %v", err)
	}

	mutations := map[string]func(*startRequest){
		"room bukan site":   func(r *startRequest) { r.Room = "leaders" },
		"room berisi path":  func(r *startRequest) { r.Room = "site-1/../x" },
		"track bukan TR_":   func(r *startRequest) { r.TrackSID = "abc" },
		"key kosong":        func(r *startRequest) { r.Key = "" },
		"key naik folder":   func(r *startRequest) { r.Key = "a/../../etc/passwd" },
		"key absolut":       func(r *startRequest) { r.Key = "/etc/passwd" },
		"bucket kosong":     func(r *startRequest) { r.Target.Bucket = "" },
		"secret kosong":     func(r *startRequest) { r.Target.Secret = "" },
		"endpoint kosong":   func(r *startRequest) { r.Target.Endpoint = "" },
		"access key kosong": func(r *startRequest) { r.Target.AccessKey = "" },
	}
	for name, mutate := range mutations {
		request := good
		mutate(&request)
		if err := request.validate(); err == nil {
			t.Errorf("%s: seharusnya ditolak", name)
		}
	}
}

func TestEndedPayloadShape(t *testing.T) {
	ok, _ := json.Marshal(endedPayload("EG_1", "lacaklive/a.webm", 1234, ""))
	var parsed struct {
		Event      string `json:"event"`
		EgressInfo struct {
			EgressID    string `json:"egressId"`
			Status      string `json:"status"`
			Error       string `json:"error"`
			FileResults []struct {
				Filename string `json:"filename"`
				Size     int64  `json:"size"`
			} `json:"fileResults"`
		} `json:"egressInfo"`
	}
	if err := json.Unmarshal(ok, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Event != "egress_ended" || parsed.EgressInfo.EgressID != "EG_1" || parsed.EgressInfo.Status != "EGRESS_COMPLETE" {
		t.Fatalf("payload sukses salah: %s", ok)
	}
	if len(parsed.EgressInfo.FileResults) != 1 || parsed.EgressInfo.FileResults[0].Size != 1234 || parsed.EgressInfo.FileResults[0].Filename != "lacaklive/a.webm" {
		t.Fatalf("fileResults salah: %s", ok)
	}

	failed, _ := json.Marshal(endedPayload("EG_2", "k", 0, "unggah gagal"))
	if !bytes.Contains(failed, []byte("EGRESS_FAILED")) || !bytes.Contains(failed, []byte("unggah gagal")) {
		t.Fatalf("payload gagal salah: %s", failed)
	}
}

func TestSplitEndpoint(t *testing.T) {
	host, secure, err := splitEndpoint("https://sgp1.digitaloceanspaces.com")
	if err != nil || host != "sgp1.digitaloceanspaces.com" || !secure {
		t.Fatalf("got %q %v %v", host, secure, err)
	}
	host, secure, _ = splitEndpoint("http://127.0.0.1:9000")
	if host != "127.0.0.1:9000" || secure {
		t.Fatalf("got %q %v", host, secure)
	}
	if _, _, err := splitEndpoint("https://"); err == nil {
		t.Fatal("endpoint kosong seharusnya ditolak")
	}
}

// fakeVP8 membuat frame VP8 palsu: keyframe membawa ukuran di byte 6-9, frame biasa hanya bit 0 = 1.
func fakeVP8(keyframe bool, width, height int) []byte {
	frame := make([]byte, 32)
	if keyframe {
		frame[0] = 0x10 // bit 0 = 0 -> keyframe
		raw := uint32(width) | uint32(height)<<16
		frame[6], frame[7], frame[8], frame[9] = byte(raw), byte(raw>>8), byte(raw>>16), byte(raw>>24)
	} else {
		frame[0] = 0x11 // bit 0 = 1 -> frame biasa
	}
	return frame
}

func TestVP8FrameInfo(t *testing.T) {
	key, w, h := vp8FrameInfo(fakeVP8(true, 1920, 1080))
	if !key || w != 1920 || h != 1080 {
		t.Fatalf("keyframe salah dibaca: %v %d %d", key, w, h)
	}
	if key, _, _ := vp8FrameInfo(fakeVP8(false, 0, 0)); key {
		t.Fatal("frame biasa terbaca keyframe")
	}
	if key, _, _ := vp8FrameInfo(nil); key {
		t.Fatal("frame kosong terbaca keyframe")
	}
}

func TestWebmFileSkipsUntilKeyframe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.webm")
	file := newWebmVideoFile(path)

	// Frame biasa sebelum keyframe pertama harus dibuang, berkas belum dibuat.
	written, err := file.Write(fakeVP8(false, 0, 0), 1000, 90000)
	if err != nil || written {
		t.Fatalf("frame sebelum keyframe: written=%v err=%v", written, err)
	}
	if _, statErr := os.Stat(path); statErr == nil {
		t.Fatal("berkas dibuat sebelum ada keyframe")
	}
	if file.Frames() != 0 {
		t.Fatal("jumlah frame harus 0")
	}
	if err := file.Close(); err != nil {
		t.Fatalf("Close tanpa penulis: %v", err)
	}
}

func TestWebmFileWritesValidContainer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.webm")
	file := newWebmVideoFile(path)

	// 60 frame ±15 fps (selang 6000 tick pada 90 kHz) dengan keyframe tiap 30 frame.
	// Cap waktu awal dekat batas uint32 untuk menguji pembungkusan.
	start := uint32(0xFFFFFFFF - 90000)
	for i := 0; i < 60; i++ {
		frame := fakeVP8(i%30 == 0, 1280, 720)
		written, err := file.Write(frame, start+uint32(i*6000), 90000)
		if err != nil || !written {
			t.Fatalf("frame %d: written=%v err=%v", i, written, err)
		}
	}
	if file.Frames() != 60 {
		t.Fatalf("frames = %d", file.Frames())
	}
	// 59 selang x 6000 tick / 90 = 3933 ms, tidak boleh negatif walau cap waktu membungkus.
	if file.lastMillis < 3900 || file.lastMillis > 3950 {
		t.Fatalf("cap waktu terakhir tidak wajar: %d ms", file.lastMillis)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil || len(data) < 1000 {
		t.Fatalf("berkas WebM kosong/pendek: len=%d err=%v", len(data), err)
	}
	// Setiap berkas EBML/WebM diawali ID 0x1A45DFA3.
	if !bytes.HasPrefix(data, []byte{0x1A, 0x45, 0xDF, 0xA3}) {
		t.Fatalf("header EBML tidak ada: % x", data[:8])
	}
	if !bytes.Contains(data, []byte("V_VP8")) {
		t.Fatal("CodecID V_VP8 tidak ada di berkas")
	}
}

func TestWebmFileNeverGoesBackwards(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.webm")
	file := newWebmVideoFile(path)
	defer file.Close()

	_, _ = file.Write(fakeVP8(true, 640, 480), 9000, 90000)
	_, _ = file.Write(fakeVP8(false, 0, 0), 9000, 90000) // cap waktu sama
	_, _ = file.Write(fakeVP8(false, 0, 0), 8000, 90000) // mundur
	if file.lastMillis < 2 {
		t.Fatalf("cap waktu harus tetap naik, lastMillis=%d", file.lastMillis)
	}
}

func TestLoadEnvFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	content := "# komentar\nTEST_REC_A=satu\nTEST_REC_B=\"dua spasi\"\nexport TEST_REC_C='tiga'\nTEST_REC_D=empat # bukan komentar baris\n\nrusak tanpa sama dengan\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TEST_REC_A", "")
	_ = os.Unsetenv("TEST_REC_A")
	_ = os.Unsetenv("TEST_REC_B")
	_ = os.Unsetenv("TEST_REC_C")
	t.Setenv("TEST_REC_D", "sudah-ada")

	if err := loadEnvFile(path); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"TEST_REC_A": "satu", "TEST_REC_B": "dua spasi", "TEST_REC_C": "tiga", "TEST_REC_D": "sudah-ada"}
	for key, value := range want {
		if got := os.Getenv(key); got != value {
			t.Errorf("%s = %q, seharusnya %q", key, got, value)
		}
	}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "read timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func TestReadErrorClassification(t *testing.T) {
	timeouts := []error{
		os.ErrDeadlineExceeded,
		fmt.Errorf("dibungkus: %w", os.ErrDeadlineExceeded),
		timeoutError{},
		errors.New("read udp: i/o timeout"),
		errors.New("deadline exceeded"),
	}
	for _, err := range timeouts {
		if !isReadTimeout(err) {
			t.Errorf("%v seharusnya dikenali sebagai batas waktu baca", err)
		}
		if isTrackEnded(err) {
			t.Errorf("%v tidak boleh dianggap akhir track", err)
		}
	}

	ended := []error{io.EOF, io.ErrClosedPipe, net.ErrClosed, fmt.Errorf("x: %w", io.EOF), errors.New("use of closed connection")}
	for _, err := range ended {
		if !isTrackEnded(err) {
			t.Errorf("%v seharusnya dikenali sebagai akhir track", err)
		}
		if isReadTimeout(err) {
			t.Errorf("%v tidak boleh dianggap batas waktu", err)
		}
	}

	if isReadTimeout(errors.New("jaringan putus")) || isTrackEnded(errors.New("jaringan putus")) {
		t.Error("galat lain harus diperlakukan sebagai galat sungguhan")
	}
}
