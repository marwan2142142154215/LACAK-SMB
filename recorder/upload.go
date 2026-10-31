package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// uploadFile mengunggah berkas ke bucket S3-compatible (DigitalOcean Spaces). Berkas besar otomatis
// diunggah bertahap (multipart) oleh pustaka. Objek bersifat privat (tanpa ACL publik).
func uploadFile(ctx context.Context, target S3Target, key, path string) error {
	if target.Bucket == "" || target.AccessKey == "" || target.Secret == "" || target.Endpoint == "" {
		return errors.New("tujuan Spaces tidak lengkap")
	}
	host, secure, err := splitEndpoint(target.Endpoint)
	if err != nil {
		return err
	}

	client, err := minio.New(host, &minio.Options{
		Creds:  credentials.NewStaticV4(target.AccessKey, target.Secret, ""),
		Secure: secure,
		Region: target.Region,
	})
	if err != nil {
		return fmt.Errorf("membuat klien S3: %w", err)
	}

	_, err = client.FPutObject(ctx, target.Bucket, key, path, minio.PutObjectOptions{ContentType: "video/webm"})
	if err != nil {
		return fmt.Errorf("FPutObject: %w", err)
	}
	return nil
}

// splitEndpoint memecah "https://sgp1.digitaloceanspaces.com" menjadi host dan penanda TLS.
func splitEndpoint(endpoint string) (host string, secure bool, err error) {
	if !strings.Contains(endpoint, "://") {
		return endpoint, true, nil
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return "", false, fmt.Errorf("endpoint tidak valid: %q", endpoint)
	}
	return parsed.Host, parsed.Scheme == "https", nil
}
