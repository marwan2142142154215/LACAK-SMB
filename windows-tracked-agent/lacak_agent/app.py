"""Inti agen: menjaga identitas, klaim rahasia, dan koneksi gateway tetap hidup.

Tanpa UI -- dipakai oleh tray.py (mode terlihat) atau bisa dijalankan sendiri
untuk uji coba. Semua perubahan status dilaporkan lewat callback on_state
supaya UI bisa menampilkannya.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

import requests

from .collectors import ScreenTimeTracker
from .config import AgentConfig
from .enrollment import EnrollmentPending, claim_secret
from .gateway_client import GatewayClient
from .identity import DeviceIdentity

# Jeda sebelum mencoba klaim lagi saat device belum didaftarkan admin.
CLAIM_RETRY_SECONDS = 30
# Jeda sebelum menyambung ulang setelah koneksi gateway terputus/gagal.
RECONNECT_SECONDS = 15


class AgentApp:
    def __init__(self, config_path: Path, on_state: Callable[[str], None] | None = None) -> None:
        self._config = AgentConfig.load(config_path)
        self._identity = DeviceIdentity()
        self._screen_tracker = ScreenTimeTracker()
        self._on_state_cb = on_state
        self._status = "Memulai..."
        self._stop = threading.Event()
        self._worker = threading.Thread(target=self._run, name="agent-worker", daemon=True)
        self._client: GatewayClient | None = None

    @property
    def device_uuid(self) -> str:
        return self._identity.device_uuid

    @property
    def status(self) -> str:
        return self._status

    def _set_state(self, status: str) -> None:
        self._status = status
        if self._on_state_cb:
            self._on_state_cb(status)

    def start(self) -> None:
        self._screen_tracker.start()
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        self._screen_tracker.stop()
        if self._client:
            self._client.stop()

    def _ensure_secret(self) -> bool:
        """True bila rahasia sudah ada/berhasil diklaim; False bila diminta berhenti."""
        while not self._stop.is_set():
            if self._identity.device_secret:
                return True
            try:
                claim_secret(self._config, self._identity)
                self._set_state("Terdaftar, menyambung...")
                return True
            except EnrollmentPending:
                self._set_state(
                    f"Menunggu admin mendaftarkan device ini. ID: {self._identity.device_uuid}"
                )
            except (requests.RequestException, KeyError):
                self._set_state("Gagal menghubungi server, mencoba lagi...")
            self._stop.wait(CLAIM_RETRY_SECONDS)
        return False

    def _run(self) -> None:
        while not self._stop.is_set():
            if not self._ensure_secret():
                return

            self._client = GatewayClient(
                config=self._config,
                identity=self._identity,
                screen_tracker=self._screen_tracker,
                on_state=self._set_state,
                on_needs_reclaim=lambda: None,  # rahasia sudah dihapus di client; loop akan klaim ulang
            )
            try:
                self._client.run_forever()
            except Exception:
                # Koneksi gagal/terputus: jeda lalu ulang dari awal (termasuk
                # klaim ulang bila rahasia sudah dihapus karena ditolak).
                self._set_state("Terputus, menyambung ulang...")
            finally:
                self._client = None

            self._stop.wait(RECONNECT_SECONDS)
