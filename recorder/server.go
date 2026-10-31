package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// maxRequestBody membatasi badan permintaan; isinya hanya beberapa baris JSON.
const maxRequestBody = 64 * 1024

// server meniru dua endpoint Twirp milik LiveKit Egress yang dipakai backend, supaya backend cukup
// mengganti alamat tujuan (RECORDER_URL) tanpa mengubah alur rekaman.
type server struct {
	cfg *Config
	hub *hub
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /twirp/livekit.Egress/StartTrackEgress", s.authorized(s.startTrackEgress))
	mux.HandleFunc("POST /twirp/livekit.Egress/StopEgress", s.authorized(s.stopEgress))
	return mux
}

// authorized hanya meneruskan permintaan ber-JWT yang ditandatangani dengan secret LiveKit.
func (s *server) authorized(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := verifyBearer(r.Header.Get("Authorization"), s.cfg.APIKey, s.cfg.APISecret, time.Now()); err != nil {
			slog.Warn("permintaan ditolak", "path", r.URL.Path, "alasan", err.Error())
			writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "unauthenticated", "msg": "token tidak sah"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
		next(w, r)
	}
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	rooms, recordings := s.hub.counts()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "rooms": rooms, "recordings": recordings})
}

type startBody struct {
	RoomName string `json:"room_name"`
	TrackID  string `json:"track_id"`
	File     struct {
		Filepath string   `json:"filepath"`
		S3       S3Target `json:"s3"`
	} `json:"file"`
}

func (s *server) startTrackEgress(w http.ResponseWriter, r *http.Request) {
	var body startBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "malformed", "msg": "JSON tidak valid"})
		return
	}
	id, err := s.hub.start(startRequest{Room: body.RoomName, TrackSID: body.TrackID, Key: body.File.Filepath, Target: body.File.S3})
	if err != nil {
		slog.Warn("gagal memulai rekaman", "room", body.RoomName, "track", body.TrackID, "err", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_argument", "msg": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"egress_id": id})
}

func (s *server) stopEgress(w http.ResponseWriter, r *http.Request) {
	var body struct {
		EgressID string `json:"egress_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.EgressID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "malformed", "msg": "egress_id wajib diisi"})
		return
	}
	if !s.hub.stop(body.EgressID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "not_found", "msg": "rekaman tidak ditemukan"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"egress_id": body.EgressID})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
