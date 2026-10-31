package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// notifier mengirim kabar "egress_ended" ke backend dengan bentuk dan tanda tangan yang sama seperti
// webhook LiveKit, jadi backend tidak perlu membedakan Egress asli dari rekorder ini.
type notifier struct {
	url       string
	apiKey    string
	apiSecret string
	client    *http.Client
}

func newNotifier(cfg Config) *notifier {
	return &notifier{
		url:       cfg.WebhookURL,
		apiKey:    cfg.APIKey,
		apiSecret: cfg.APISecret,
		client:    &http.Client{Timeout: 10 * time.Second},
	}
}

type fileResult struct {
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
}

type egressInfo struct {
	EgressID    string       `json:"egressId"`
	Status      string       `json:"status"`
	Error       string       `json:"error,omitempty"`
	FileResults []fileResult `json:"fileResults"`
}

type endedEvent struct {
	Event      string     `json:"event"`
	EgressInfo egressInfo `json:"egressInfo"`
}

// endedPayload menyusun badan webhook. errText kosong = berhasil.
func endedPayload(id, key string, size int64, errText string) endedEvent {
	info := egressInfo{EgressID: id, Status: "EGRESS_COMPLETE", FileResults: []fileResult{{Filename: key, Size: size}}}
	if errText != "" {
		info.Status = "EGRESS_FAILED"
		info.Error = errText
	}
	return endedEvent{Event: "egress_ended", EgressInfo: info}
}

// ended melaporkan akhir satu rekaman. Dicoba ulang beberapa kali (backend bisa sedang restart).
func (n *notifier) ended(id, key string, size int64, errText string) {
	body, err := json.Marshal(endedPayload(id, key, size, errText))
	if err != nil {
		slog.Error("menyusun webhook gagal", "err", err)
		return
	}

	delays := []time.Duration{0, 2 * time.Second, 5 * time.Second, 15 * time.Second}
	var lastErr error
	for _, delay := range delays {
		if delay > 0 {
			time.Sleep(delay)
		}
		if lastErr = n.post(body); lastErr == nil {
			return
		}
	}
	slog.Error("webhook ke backend gagal setelah beberapa percobaan", "egress_id", id, "err", lastErr)
}

func (n *notifier) post(body []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, n.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/webhook+json")
	request.Header.Set("Authorization", signWebhook(n.apiKey, n.apiSecret, body, time.Now()))

	response, err := n.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
	if response.StatusCode/100 != 2 {
		return fmt.Errorf("backend membalas HTTP %d", response.StatusCode)
	}
	return nil
}
