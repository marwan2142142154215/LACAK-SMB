"""Konfigurasi agen dari config.json.

Nilai per-site (kode site, URL gateway, URL backend) datang dari berkas, bukan
ditanam di kode -- satu paket agen yang sama dipakai banyak site, admin tinggal
mengisi config.json saat deploy.
"""

from __future__ import annotations

import json
from pathlib import Path


class ConfigError(Exception):
    """Config.json hilang atau field wajibnya kosong."""


class AgentConfig:
    def __init__(self, gateway_url: str, backend_api_url: str, site_code: str,
                 app_version: str, report_interval_seconds: int) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.backend_api_url = backend_api_url.rstrip("/")
        self.site_code = site_code
        self.app_version = app_version
        self.report_interval_seconds = report_interval_seconds

    @classmethod
    def load(cls, path: Path) -> "AgentConfig":
        if not path.exists():
            raise ConfigError(
                f"config.json tidak ditemukan di {path}. Salin config.example.json "
                "menjadi config.json lalu isi sesuai site."
            )

        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as error:
            raise ConfigError(f"config.json tidak valid: {error}") from error

        required = ("gateway_url", "backend_api_url", "site_code")
        missing = [key for key in required if not raw.get(key)]
        if missing:
            raise ConfigError(f"Field wajib kosong di config.json: {', '.join(missing)}")

        return cls(
            gateway_url=raw["gateway_url"],
            backend_api_url=raw["backend_api_url"],
            site_code=raw["site_code"],
            app_version=raw.get("app_version", "1.0.0"),
            report_interval_seconds=int(raw.get("report_interval_seconds", 300)),
        )
