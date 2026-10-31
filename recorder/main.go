// Command recorder merekam track video staf Live Kerja (kamera & layar) dari LiveKit TANPA Docker dan TANPA
// GStreamer: paket VP8 ditulis apa adanya ke WebM, lalu diunggah ke DigitalOcean Spaces.
//
// Backend memanggilnya seperti LiveKit Egress (StartTrackEgress / StopEgress); hasilnya dilaporkan kembali lewat
// webhook "egress_ended". Lihat recorder/README.md.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	envFile := flag.String("env", "", "berkas .env untuk dibaca (mis. ../backend-adonis/.env); variabel yang sudah diset tidak ditimpa")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	if *envFile != "" {
		if err := loadEnvFile(*envFile); err != nil {
			slog.Error("tidak bisa membaca berkas env", "path", *envFile, "err", err)
			os.Exit(1)
		}
	}

	cfg, err := loadConfig()
	if err != nil {
		slog.Error("konfigurasi tidak valid", "err", err)
		os.Exit(1)
	}

	cleanOldTempFiles(cfg.TmpDir, 24*time.Hour)

	h := newHub(&cfg, newNotifier(cfg))
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           (&server{cfg: &cfg, hub: h}).routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      60 * time.Second,
	}

	go func() {
		slog.Info("rekorder berjalan", "listen", cfg.Listen, "livekit", cfg.LiveKitURL, "webhook", cfg.WebhookURL)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server berhenti", "err", err)
			os.Exit(1)
		}
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals

	slog.Info("menghentikan rekorder: menyelesaikan rekaman yang berjalan")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	h.shutdown(90 * time.Second)
}

// cleanOldTempFiles membersihkan sisa berkas sementara dari proses yang mati mendadak.
func cleanOldTempFiles(dir string, olderThan time.Duration) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || entry.IsDir() {
			continue
		}
		if time.Since(info.ModTime()) > olderThan {
			_ = os.Remove(dir + string(os.PathSeparator) + entry.Name())
		}
	}
}
