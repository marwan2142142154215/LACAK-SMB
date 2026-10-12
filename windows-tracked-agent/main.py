"""Titik masuk agen tray LACAK-SMB untuk Windows.

Jalankan dengan pythonw agar tanpa jendela konsol:
    pythonw main.py

config.json dicari di folder yang sama dengan berkas ini (atau di sebelah .exe
saat sudah dibekukan dengan PyInstaller).
"""

from __future__ import annotations

import ctypes
import sys
from pathlib import Path

from lacak_agent.config import ConfigError
from lacak_agent.tray import TrayApp


def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).parent


def _show_error(message: str) -> None:
    # MessageBox Windows supaya kesalahan konfigurasi tetap terlihat walau
    # dijalankan tanpa konsol (pythonw).
    ctypes.windll.user32.MessageBoxW(0, message, "LACAK-SMB Agent", 0x10)


def main() -> int:
    config_path = _base_dir() / "config.json"
    try:
        TrayApp(config_path).run()
    except ConfigError as error:
        _show_error(str(error))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
