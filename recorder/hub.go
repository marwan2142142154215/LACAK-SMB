package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

var (
	roomPattern = regexp.MustCompile(`^site-\d+$`)
	sidPattern  = regexp.MustCompile(`^TR_[A-Za-z0-9]+$`)
)

const (
	// Berapa lama langganan track dipertahankan setelah satu rekaman selesai, supaya rekaman jam berikutnya
	// langsung lanjut tanpa menunggu langganan ulang (pemotongan per jam tanpa celah panjang).
	lingerAfterStop = 30 * time.Second
	// Berapa lama menunggu track muncul di room setelah backend memintanya (webhook bisa mendahului sinkronisasi).
	publicationWait = 15 * time.Second
	// Batas menunggu aliran track setelah berlangganan.
	subscribeTimeout = 30 * time.Second
)

// trackHandle adalah track yang sudah dilanggani rekorder.
type trackHandle struct {
	track  *webrtc.TrackRemote
	pub    *lksdk.RemoteTrackPublication
	rp     *lksdk.RemoteParticipant
	linger *time.Timer
}

// roomConn adalah satu sambungan rekorder ke satu room site (penonton tersembunyi).
type roomConn struct {
	name   string
	room   *lksdk.Room
	tracks map[string]*trackHandle // track yang sudah dilanggani, menurut SID
	active map[string]*recording   // rekaman berjalan/menunggu, menurut SID
}

type startRequest struct {
	Room     string
	TrackSID string
	Key      string
	Target   S3Target
}

type hub struct {
	cfg      *Config
	notifier *notifier

	connectMu sync.Mutex // satu sambungan room dibuat pada satu waktu
	mu        sync.Mutex
	rooms     map[string]*roomConn
	byID      map[string]*recording
}

func newHub(cfg *Config, notifier *notifier) *hub {
	return &hub{cfg: cfg, notifier: notifier, rooms: map[string]*roomConn{}, byID: map[string]*recording{}}
}

func newEgressID() string {
	buffer := make([]byte, 8)
	_, _ = rand.Read(buffer)
	return "EG_" + hex.EncodeToString(buffer)
}

// validate memastikan permintaan dari backend berbentuk wajar sebelum menyentuh LiveKit atau disk.
func (r startRequest) validate() error {
	if !roomPattern.MatchString(r.Room) {
		return fmt.Errorf("nama room tidak valid: %q", r.Room)
	}
	if !sidPattern.MatchString(r.TrackSID) {
		return fmt.Errorf("track_id tidak valid: %q", r.TrackSID)
	}
	if r.Key == "" || strings.Contains(r.Key, "..") || strings.HasPrefix(r.Key, "/") || len(r.Key) > 512 {
		return fmt.Errorf("filepath tidak valid")
	}
	if r.Target.Bucket == "" || r.Target.AccessKey == "" || r.Target.Secret == "" || r.Target.Endpoint == "" {
		return errors.New("tujuan s3 tidak lengkap")
	}
	return nil
}

// start memulai rekaman satu track dan mengembalikan egress_id.
func (h *hub) start(req startRequest) (string, error) {
	if err := req.validate(); err != nil {
		return "", err
	}

	rc, err := h.roomFor(req.Room)
	if err != nil {
		return "", fmt.Errorf("masuk ke room: %w", err)
	}

	h.mu.Lock()
	if existing := rc.active[req.TrackSID]; existing != nil {
		h.mu.Unlock()
		return existing.id, nil
	}
	h.mu.Unlock()

	pub, _ := h.waitPublication(rc, req.TrackSID, publicationWait)
	if pub == nil {
		return "", fmt.Errorf("track %s tidak ditemukan di room %s", req.TrackSID, req.Room)
	}

	rec := newRecording(h.cfg, h.notifier, newEgressID(), req.Room, req.TrackSID, req.Key, req.Target)

	h.mu.Lock()
	rc.active[req.TrackSID] = rec
	h.byID[rec.id] = rec
	handle := rc.tracks[req.TrackSID]
	if handle != nil && handle.linger != nil {
		handle.linger.Stop()
		handle.linger = nil
	}
	h.mu.Unlock()

	if handle != nil {
		// Langganan masih ada (rekaman sebelumnya baru selesai): pakai lagi, minta keyframe baru.
		go h.runRecording(rc, rec, handle)
		return rec.id, nil
	}

	if err := pub.SetSubscribed(true); err != nil {
		h.forget(rc, rec)
		return "", fmt.Errorf("berlangganan track: %w", err)
	}
	// Kalau track tidak kunjung mengalir, jangan biarkan catatan rekaman menggantung selamanya.
	time.AfterFunc(subscribeTimeout, func() { h.abandon(rc, rec, "track tidak kunjung diterima") })
	// Kunci kualitas tertinggi supaya resolusi tidak berganti di tengah berkas (staf mengirim simulcast).
	_ = pub.SetVideoQuality(livekit.VideoQuality_HIGH)
	return rec.id, nil
}

// stop menghentikan rekaman; berkas diselesaikan & dilaporkan secara asinkron.
func (h *hub) stop(egressID string) bool {
	h.mu.Lock()
	rec := h.byID[egressID]
	h.mu.Unlock()
	if rec == nil {
		return false
	}
	rec.requestStop()
	return true
}

// counts dipakai endpoint /health.
func (h *hub) counts() (rooms, recordings int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms), len(h.byID)
}

// shutdown menghentikan semua rekaman dan menunggu berkasnya diselesaikan (maksimal timeout).
func (h *hub) shutdown(timeout time.Duration) {
	h.mu.Lock()
	var pending []*recording
	for _, rec := range h.byID {
		pending = append(pending, rec)
	}
	h.mu.Unlock()

	for _, rec := range pending {
		rec.requestStop()
	}
	deadline := time.After(timeout)
	for _, rec := range pending {
		select {
		case <-rec.done:
		case <-deadline:
			slog.Warn("shutdown: ada rekaman yang belum selesai sampai batas waktu")
			return
		}
	}
	h.mu.Lock()
	for _, rc := range h.rooms {
		rc.room.Disconnect()
	}
	h.mu.Unlock()
}

func (h *hub) runRecording(rc *roomConn, rec *recording, handle *trackHandle) {
	keyframe := func(ssrc webrtc.SSRC) { handle.rp.WritePLI(ssrc) }
	rec.run(handle.track, keyframe)
	h.finished(rc, rec)
}

// abandon menutup rekaman yang belum sempat berjalan (track hilang / tidak mengalir) dan melapor gagal ke backend,
// supaya barisnya tidak menggantung berstatus "recording".
func (h *hub) abandon(rc *roomConn, rec *recording, reason string) {
	if rec.running.Load() {
		return
	}
	h.mu.Lock()
	owned := rc.active[rec.trackSID] == rec
	h.mu.Unlock()
	if !owned {
		return
	}
	rec.started.Do(func() {}) // cegah run() berjalan sesudahnya
	h.forget(rc, rec)
	close(rec.done)
	go rec.notifier.ended(rec.id, rec.key, 0, reason)
}

// forget melepas catatan rekaman yang gagal dimulai.
func (h *hub) forget(rc *roomConn, rec *recording) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rc.active[rec.trackSID] == rec {
		delete(rc.active, rec.trackSID)
	}
	delete(h.byID, rec.id)
}

// finished dipanggil saat satu rekaman selesai: lepas catatan, lalu atur masa tunggu langganan.
func (h *hub) finished(rc *roomConn, rec *recording) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rc.active[rec.trackSID] == rec {
		delete(rc.active, rec.trackSID)
	}
	delete(h.byID, rec.id)

	handle := rc.tracks[rec.trackSID]
	if handle == nil {
		h.maybeLeaveLocked(rc)
		return
	}
	sid := rec.trackSID
	handle.linger = time.AfterFunc(lingerAfterStop, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if rc.active[sid] != nil {
			return // sudah ada rekaman baru yang memakai langganan ini
		}
		if current := rc.tracks[sid]; current != nil {
			_ = current.pub.SetSubscribed(false)
			delete(rc.tracks, sid)
		}
		h.maybeLeaveLocked(rc)
	})
}

// maybeLeaveLocked keluar dari room kalau tidak ada lagi yang direkam atau dilanggani (h.mu sudah dipegang).
func (h *hub) maybeLeaveLocked(rc *roomConn) {
	if len(rc.active) == 0 && len(rc.tracks) == 0 && h.rooms[rc.name] == rc {
		delete(h.rooms, rc.name)
		go rc.room.Disconnect()
	}
}

// waitPublication menunggu sampai track dengan SID itu muncul di room.
func (h *hub) waitPublication(rc *roomConn, sid string, timeout time.Duration) (*lksdk.RemoteTrackPublication, *lksdk.RemoteParticipant) {
	deadline := time.Now().Add(timeout)
	for {
		for _, participant := range rc.room.GetRemoteParticipants() {
			for _, publication := range participant.TrackPublications() {
				if remote, ok := publication.(*lksdk.RemoteTrackPublication); ok && remote.SID() == sid {
					return remote, participant
				}
			}
		}
		if time.Now().After(deadline) {
			return nil, nil
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// roomFor mengembalikan sambungan room yang sudah ada, atau membuat yang baru.
func (h *hub) roomFor(name string) (*roomConn, error) {
	h.connectMu.Lock()
	defer h.connectMu.Unlock()

	h.mu.Lock()
	existing := h.rooms[name]
	h.mu.Unlock()
	if existing != nil {
		return existing, nil
	}

	token := auth.NewAccessToken(h.cfg.APIKey, h.cfg.APISecret).
		SetIdentity("recorder-" + name).
		SetValidFor(time.Hour)
	grant := &auth.VideoGrant{RoomJoin: true, Room: name, Hidden: true, Recorder: true}
	grant.SetCanSubscribe(true)
	grant.SetCanPublish(false)
	grant.SetCanPublishData(false)
	jwt, err := token.SetVideoGrant(grant).ToJWT()
	if err != nil {
		return nil, fmt.Errorf("membuat token: %w", err)
	}

	rc := &roomConn{name: name, tracks: map[string]*trackHandle{}, active: map[string]*recording{}}
	callback := &lksdk.RoomCallback{
		ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackSubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
				h.onSubscribed(rc, track, pub, rp)
			},
			OnTrackUnsubscribed: func(_ *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
				h.onTrackGone(rc, pub.SID())
			},
			OnTrackUnpublished: func(pub *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
				h.onTrackGone(rc, pub.SID())
			},
		},
		OnDisconnected: func() { h.onDisconnected(rc) },
	}

	room, err := lksdk.ConnectToRoomWithToken(h.cfg.LiveKitURL, jwt, callback, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return nil, err
	}
	rc.room = room

	h.mu.Lock()
	h.rooms[name] = rc
	h.mu.Unlock()
	slog.Info("rekorder masuk ke room", "room", name)
	return rc, nil
}

// onSubscribed dipanggil SDK saat track yang diminta sudah mengalir.
func (h *hub) onSubscribed(rc *roomConn, track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
	sid := pub.SID()
	h.mu.Lock()
	handle := &trackHandle{track: track, pub: pub, rp: rp}
	rc.tracks[sid] = handle
	rec := rc.active[sid]
	h.mu.Unlock()

	if rec == nil {
		return // langganan tanpa rekaman (sisa); akan dilepas oleh masa tunggu
	}
	go h.runRecording(rc, rec, handle)
}

func (h *hub) onTrackGone(rc *roomConn, sid string) {
	h.mu.Lock()
	delete(rc.tracks, sid)
	rec := rc.active[sid]
	h.mu.Unlock()
	if rec != nil {
		rec.requestStop()
		h.abandon(rc, rec, "track berakhir sebelum direkam")
	}
}

func (h *hub) onDisconnected(rc *roomConn) {
	h.mu.Lock()
	if h.rooms[rc.name] == rc {
		delete(h.rooms, rc.name)
	}
	var recs []*recording
	for _, rec := range rc.active {
		recs = append(recs, rec)
	}
	h.mu.Unlock()

	slog.Warn("terputus dari room", "room", rc.name, "rekaman_aktif", len(recs))
	for _, rec := range recs {
		rec.requestStop()
		h.abandon(rc, rec, "terputus dari room sebelum direkam")
	}
}
