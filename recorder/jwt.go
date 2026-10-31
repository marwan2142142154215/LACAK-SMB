package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// JWT HS256 minimal, sama dengan yang dipakai LiveKit untuk webhook dan API: header.payload.signature
// (base64url tanpa padding). Dipakai untuk (1) memeriksa token dari backend, (2) menandatangani webhook ke backend.

var jwtHeader = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))

func sign(secret, signingInput string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signingInput))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// signWebhook membuat token untuk webhook: iss = API key, sha256 = base64(sha256(body)) (dihitung backend untuk dicocokkan).
func signWebhook(apiKey, secret string, body []byte, now time.Time) string {
	digest := sha256.Sum256(body)
	claims, _ := json.Marshal(map[string]any{
		"iss":    apiKey,
		"nbf":    now.Add(-time.Minute).Unix(),
		"exp":    now.Add(5 * time.Minute).Unix(),
		"sha256": base64.StdEncoding.EncodeToString(digest[:]),
	})
	signingInput := jwtHeader + "." + base64.RawURLEncoding.EncodeToString(claims)
	return signingInput + "." + sign(secret, signingInput)
}

// verifyBearer memeriksa header Authorization dari backend: tanda tangan HMAC, issuer, dan masa berlaku.
func verifyBearer(authorization, apiKey, secret string, now time.Time) error {
	token := strings.TrimSpace(authorization)
	if len(token) > 7 && strings.EqualFold(token[:7], "bearer ") {
		token = strings.TrimSpace(token[7:])
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return errors.New("token tidak berbentuk JWT")
	}
	expected := sign(secret, parts[0]+"."+parts[1])
	if !hmac.Equal([]byte(expected), []byte(parts[2])) {
		return errors.New("tanda tangan tidak cocok")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return errors.New("payload token rusak")
	}
	var claims struct {
		Iss string  `json:"iss"`
		Exp float64 `json:"exp"`
		Nbf float64 `json:"nbf"`
	}
	if err := json.Unmarshal(raw, &claims); err != nil {
		return errors.New("payload token rusak")
	}
	if claims.Iss != apiKey {
		return errors.New("issuer tidak dikenal")
	}
	if claims.Exp != 0 && int64(claims.Exp) < now.Unix()-60 {
		return errors.New("token kedaluwarsa")
	}
	if claims.Nbf != 0 && int64(claims.Nbf) > now.Unix()+60 {
		return errors.New("token belum berlaku")
	}
	return nil
}
