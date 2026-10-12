"""Penyimpanan identitas device untuk PC Windows.

device_uuid dibuat sekali di PC ini lalu ditampilkan ke operator supaya admin
bisa mendaftarkannya di dashboard (sama seperti ID di layar APK Android).
device_secret diterbitkan server saat klaim enrollment dan HANYA disimpan di
sini; server menyimpan hash-nya saja.

Keduanya ditaruh di %LOCALAPPDATA%\\LacakSMB, bukan di folder aplikasi, supaya
tidak ikut tersalin saat instalasi dibagikan dan tetap per-pengguna.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path


def _state_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    path = Path(base) / "LacakSMB"
    path.mkdir(parents=True, exist_ok=True)
    return path


class DeviceIdentity:
    """Membaca/menulis device_uuid dan device_secret di disk lokal."""

    def __init__(self) -> None:
        self._file = _state_dir() / "identity.json"
        self._data = self._load()

    def _load(self) -> dict:
        if not self._file.exists():
            return {}
        try:
            return json.loads(self._file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # Berkas rusak jangan menghentikan agen: perlakukan seperti belum ada
            # identitas, device_uuid baru dibuat dan operator klaim ulang.
            return {}

    def _save(self) -> None:
        self._file.write_text(json.dumps(self._data, indent=4), encoding="utf-8")

    @property
    def device_uuid(self) -> str:
        """device_uuid stabil; dibuat sekali saat pertama kali dijalankan."""
        if not self._data.get("device_uuid"):
            self._data["device_uuid"] = str(uuid.uuid4())
            self._save()
        return self._data["device_uuid"]

    @property
    def device_secret(self) -> str | None:
        return self._data.get("device_secret")

    def set_secret(self, secret: str) -> None:
        self._data["device_secret"] = secret
        self._save()

    def clear_secret(self) -> None:
        """Dipanggil saat gateway menolak kredensial (perlu klaim ulang)."""
        self._data.pop("device_secret", None)
        self._save()
