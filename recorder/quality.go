package main

import (
	"fmt"
	"strings"

	"github.com/livekit/protocol/livekit"
)

// parseQuality membaca RECORDER_CAMERA_QUALITY: low (180p), medium (360p), high (720p).
func parseQuality(value string) (livekit.VideoQuality, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low":
		return livekit.VideoQuality_LOW, nil
	case "medium":
		return livekit.VideoQuality_MEDIUM, nil
	case "high":
		return livekit.VideoQuality_HIGH, nil
	}
	return livekit.VideoQuality_HIGH, fmt.Errorf("RECORDER_CAMERA_QUALITY harus low, medium, atau high, bukan %q", value)
}

// qualityFor menentukan lapisan simulcast yang direkam. Kamera cukup lapisan menengah (360p, +-0,2 GB/jam
// dibanding +-1,1 GB/jam di 720p) -- dan karena staf mengirim dengan dynacast, lapisan 720p tidak ikut dipaksa
// menyala hanya demi rekaman. Layar tetap kualitas penuh supaya teksnya terbaca.
func (c *Config) qualityFor(source livekit.TrackSource) livekit.VideoQuality {
	if source == livekit.TrackSource_CAMERA {
		return c.CameraQuality
	}
	return livekit.VideoQuality_HIGH
}
