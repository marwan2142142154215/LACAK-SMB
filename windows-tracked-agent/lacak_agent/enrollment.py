"""Klaim enrollment: menukar device_uuid dengan device_secret sekali.

Sama dengan DeviceEnrollmentApi di aplikasi Android. Admin mendaftarkan device
di dashboard memakai device_uuid yang tampil di jendela agen; agen lalu
memanggil endpoint publik /device-enrollments/claim untuk menerima rahasianya.
"""

from __future__ import annotations

import requests

from .config import AgentConfig
from .identity import DeviceIdentity


class EnrollmentPending(Exception):
    """Device belum didaftarkan admin (atau perlu didaftarkan ulang)."""


def claim_secret(config: AgentConfig, identity: DeviceIdentity) -> str:
    """Mengembalikan device_secret; menyimpannya ke identity bila berhasil."""
    response = requests.post(
        f"{config.backend_api_url}/device-enrollments/claim",
        json={"device_uuid": identity.device_uuid},
        headers={"Accept": "application/json"},
        timeout=15,
    )

    if response.status_code == 404:
        # Backend sengaja menyamakan "belum didaftarkan" dan "sudah diklaim"
        # supaya status device tidak bisa ditebak dari luar.
        raise EnrollmentPending(
            "Device belum didaftarkan admin atau perlu didaftarkan ulang."
        )

    response.raise_for_status()
    secret = response.json()["data"]["device_secret"]
    identity.set_secret(secret)
    return secret
