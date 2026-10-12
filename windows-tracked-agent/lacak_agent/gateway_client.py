"""Koneksi Socket.IO ke realtime-gateway namespace /device.

Protokol sama dengan GatewaySocketClient Android:
  - handshake auth membawa deviceUuid + deviceSecret (diverifikasi middleware
    device di gateway terhadap devices.secret_hash),
  - setelah tersambung agen mengirim device:hello {deviceUuid, siteCode,
    appBuildVersion},
  - gateway membalas device:accepted (device tercatat online) atau
    device:rejected,
  - agen lalu mengirim device:status_report berkala.

Bila gateway menolak kredensial (invalid_credentials / reenroll_required),
rahasia lokal dihapus supaya agen mengklaim ulang -- sama seperti perilaku APK.
"""

from __future__ import annotations

from typing import Callable

import socketio

from .collectors import ScreenTimeTracker, build_status_report
from .config import AgentConfig
from .identity import DeviceIdentity

NAMESPACE = "/device"


class GatewayClient:
    def __init__(self, config: AgentConfig, identity: DeviceIdentity,
                 screen_tracker: ScreenTimeTracker,
                 on_state: Callable[[str], None],
                 on_needs_reclaim: Callable[[], None]) -> None:
        self._config = config
        self._identity = identity
        self._screen_tracker = screen_tracker
        self._on_state = on_state
        self._on_needs_reclaim = on_needs_reclaim

        # Reconnection ditangani socketio; backoff supaya tidak membanjiri gateway.
        self._sio = socketio.Client(
            reconnection=True,
            reconnection_delay=5,
            reconnection_delay_max=60,
        )
        self._report_task = None
        self._register_handlers()

    def _register_handlers(self) -> None:
        sio = self._sio

        @sio.event(namespace=NAMESPACE)
        def connect() -> None:
            self._on_state("Terhubung, mengirim identitas...")
            sio.emit(
                "device:hello",
                {
                    "deviceUuid": self._identity.device_uuid,
                    "siteCode": self._config.site_code,
                    "appBuildVersion": self._config.app_version,
                },
                namespace=NAMESPACE,
            )

        @sio.on("device:accepted", namespace=NAMESPACE)
        def on_accepted(_data) -> None:
            self._on_state("Aktif dipantau")
            if self._report_task is None:
                self._report_task = sio.start_background_task(self._report_loop)

        @sio.on("device:rejected", namespace=NAMESPACE)
        def on_rejected(data) -> None:
            message = (data or {}).get("message", "Ditolak gateway")
            self._on_state(f"Ditolak: {message}")

        @sio.event(namespace=NAMESPACE)
        def connect_error(data) -> None:
            code = (data or {}).get("data", {}).get("code") if isinstance(data, dict) else None
            if code in ("invalid_credentials", "reenroll_required"):
                # Rahasia tidak berlaku lagi -> hapus dan minta klaim ulang.
                self._identity.clear_secret()
                self._on_state("Perlu didaftarkan ulang oleh admin")
                self._on_needs_reclaim()
            else:
                self._on_state("Gagal menyambung ke gateway")

    def _report_loop(self) -> None:
        # Kirim satu laporan segera setelah diterima, lalu tiap interval.
        while self._sio.connected:
            try:
                report = build_status_report(self._config.app_version, self._screen_tracker)
                self._sio.emit("device:status_report", report, namespace=NAMESPACE)
            except Exception:
                # Kegagalan membangun/mengirim satu laporan tidak boleh memutus
                # koneksi; dicoba lagi pada interval berikutnya.
                pass
            self._sio.sleep(self._config.report_interval_seconds)
        self._report_task = None

    def run_forever(self) -> None:
        """Menyambung dan memblokir sampai stop(); dipanggil dari thread agen."""
        secret = self._identity.device_secret
        if not secret:
            raise RuntimeError("device_secret belum ada; klaim enrollment dulu")

        # Transport dibiarkan dinegosiasikan Engine.IO (polling dulu, lalu naik
        # ke websocket bila bisa). Tidak memaksa websocket supaya tetap jalan
        # lewat proxy/jaringan yang memblokir websocket langsung.
        self._sio.connect(
            self._config.gateway_url,
            namespaces=[NAMESPACE],
            auth={"deviceUuid": self._identity.device_uuid, "deviceSecret": secret},
            wait_timeout=20,
        )
        self._sio.wait()

    def stop(self) -> None:
        try:
            if self._sio.connected:
                self._sio.disconnect()
        except Exception:
            pass
