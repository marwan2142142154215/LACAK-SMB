package main

import (
	"log/slog"
	"os"

	"github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// setupLogging memisahkan dua jenis log:
//   - log SDK LiveKit & Pion (paket duplikat, ICE, dst.): hanya sdkLevel ke atas ("warn"), karena di INFO volumenya besar sekali;
//   - log rekorder sendiri (masuk room, rekaman tersimpan, galat): selalu INFO ke atas, ke stdout.
//
// Urutannya penting: logger.InitFromConfig MENIMPA slog bawaan dengan handler ber-level sdkLevel yang menulis
// ke stderr, jadi slog bawaan harus dipasang ulang SESUDAHNYA (dulu tidak, dan log rekorder ikut hilang).
func setupLogging(sdkLevel string) {
	logger.InitFromConfig(&logger.Config{Level: sdkLevel}, "recorder")
	lksdk.SetLogger(logger.GetLogger())

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
}
