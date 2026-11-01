package main

import (
	"bufio"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strings"
	"time"
)

// Config dibaca dari environment (dan opsional berkas .env, supaya key LiveKit tidak diduplikasi).
type Config struct {
	// Alamat HTTP yang didengar rekorder. Loopback (backend di server yang sama) atau IP privat (VPC) --
	// tidak pernah IP publik.
	Listen string
	// URL LiveKit untuk rekorder (WebSocket), biasanya ws://127.0.0.1:7880.
	LiveKitURL string
	APIKey     string
	APISecret  string
	// Webhook backend yang menerima "egress_ended" (sama dengan webhook LiveKit).
	WebhookURL string
	// Folder sementara untuk berkas yang sedang direkam.
	TmpDir string
	// Batas keras satu segmen; pemotongan per jam dilakukan backend, ini hanya jaring pengaman.
	MaxSegment time.Duration
	// Jalur ffmpeg untuk memperbaiki durasi/indeks (-c copy). Kosong = tidak dipakai.
	FFmpeg string
}

// loadEnvFile membaca baris KEY=VALUE (abaikan komentar & kutip) ke environment proses,
// tanpa menimpa variabel yang sudah diset di luar.
func loadEnvFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(strings.TrimPrefix(key, "export "))
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, value)
		}
	}
	return scanner.Err()
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func loadConfig() (Config, error) {
	cfg := Config{
		Listen:     envOr("RECORDER_LISTEN", "127.0.0.1:7870"),
		LiveKitURL: envOr("RECORDER_LIVEKIT_URL", "ws://127.0.0.1:7880"),
		APIKey:     os.Getenv("LIVEKIT_API_KEY"),
		APISecret:  os.Getenv("LIVEKIT_API_SECRET"),
		WebhookURL: envOr("RECORDER_WEBHOOK_URL", "http://127.0.0.1:7564/api/v1/livekit/webhook"),
		TmpDir:     envOr("RECORDER_TMP_DIR", os.TempDir()+string(os.PathSeparator)+"lacak-recorder"),
		FFmpeg:     os.Getenv("RECORDER_FFMPEG"),
		MaxSegment: 2 * time.Hour,
	}
	if cfg.APIKey == "" || cfg.APISecret == "" {
		return cfg, fmt.Errorf("LIVEKIT_API_KEY dan LIVEKIT_API_SECRET wajib diisi")
	}
	if !isLoopback(cfg.Listen) && !isPrivateListen(cfg.Listen) {
		return cfg, fmt.Errorf("RECORDER_LISTEN harus loopback (127.0.0.1/localhost/[::1]) atau IP jaringan privat (10.x, 172.16-31.x, 192.168.x), bukan %q", cfg.Listen)
	}
	return cfg, nil
}

// isPrivateListen mengizinkan rekorder di server LiveKit terpisah dipanggil backend lewat jaringan
// privat (VPC): hanya IP literal RFC1918, tidak pernah 0.0.0.0, nama host, atau IP publik.
// Pembatasan siapa yang boleh menyambung tetap lewat firewall + token bearer.
func isPrivateListen(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return ip.Is4() && ip.IsPrivate()
}

// isLoopback memastikan rekorder tidak pernah terbuka ke jaringan luar.
func isLoopback(addr string) bool {
	host, _, found := strings.Cut(addr, ":")
	if strings.HasPrefix(addr, "[") {
		end := strings.Index(addr, "]")
		if end < 0 {
			return false
		}
		return addr[1:end] == "::1"
	}
	return found && (host == "127.0.0.1" || host == "localhost")
}
