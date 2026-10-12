"""Daftarkan agen agar jalan otomatis saat pengguna login.

Memakai Run key milik PENGGUNA (HKCU), bukan layanan sistem tersembunyi:
entri ini terlihat di Task Manager > Startup dan bisa dilihat/dicabut pemilik
PC. Ini disengaja -- agen manajemen aset harus kasat mata, bukan siluman.
"""

from __future__ import annotations

import sys
import winreg

_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_VALUE_NAME = "LacakSMBAgent"


def _command() -> str:
    # Saat dibekukan jadi .exe (PyInstaller) sys.frozen True -> jalankan exe-nya.
    # Saat dari sumber, jalankan pythonw + main.py agar tanpa jendela konsol.
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    main_script = f'"{sys.argv[0]}"'
    return f'"{sys.executable}" {main_script}'


def enable() -> None:
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, _VALUE_NAME, 0, winreg.REG_SZ, _command())


def disable() -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, _VALUE_NAME)
    except FileNotFoundError:
        pass


def is_enabled() -> bool:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY) as key:
            winreg.QueryValueEx(key, _VALUE_NAME)
            return True
    except FileNotFoundError:
        return False
