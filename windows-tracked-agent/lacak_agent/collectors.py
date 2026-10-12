"""Pengumpul status PC Windows untuk payload device:status_report.

Lingkup SENGAJA dibatasi ke telemetri aset milik perusahaan: baterai, jaringan,
info PC, lama layar aktif, dan daftar aplikasi depan + durasinya. TIDAK membaca
judul jendela, isi aplikasi, ketikan, maupun layar -- hanya nama proses yang
sedang di depan dan berapa lama. Ini membuat agen tetap alat manajemen aset,
bukan alat penyadapan.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import platform
import shutil
import threading
import time
import winreg
from datetime import date, datetime

import psutil

# Ambang diam: tidak ada input mouse/keyboard selama ini -> layar dianggap tidak
# aktif dipakai (termasuk saat PC terkunci, karena input ke secure desktop tidak
# memperbarui GetLastInputInfo di desktop biasa).
IDLE_THRESHOLD_SECONDS = 60
# Interval sampling waktu-aktif & aplikasi depan. Kecil supaya akurat, tapi
# bukan nol supaya tidak membebani CPU.
SAMPLE_INTERVAL_SECONDS = 5
# Simpan hari ini + kemarin saja (kontrak hanya minta dua hari terakhir).
RETAINED_DAYS = 2


class _LastInputInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def _idle_seconds() -> float:
    """Detik sejak input terakhir pengguna (GetLastInputInfo)."""
    info = _LastInputInfo()
    info.cbSize = ctypes.sizeof(_LastInputInfo)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    millis_since_boot = ctypes.windll.kernel32.GetTickCount()
    return max(0.0, (millis_since_boot - info.dwTime) / 1000.0)


def _foreground_process_name() -> str | None:
    """Nama proses jendela depan (tanpa judul jendela). None bila tak terbaca."""
    hwnd = ctypes.windll.user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return None
    try:
        return psutil.Process(pid.value).name()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def _registry_value(path: str, name: str) -> str | None:
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            value, _ = winreg.QueryValueEx(key, name)
            return str(value).strip() or None
    except OSError:
        return None


class ScreenTimeTracker:
    """Mengakumulasi lama layar aktif dan durasi aplikasi depan per hari.

    Dijalankan di thread terpisah: tiap SAMPLE_INTERVAL_SECONDS ia memutuskan
    PC sedang aktif dipakai atau diam, lalu menambah detik ke hari & aplikasi
    yang sesuai. Aman diakses lintas-thread lewat satu lock.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="screen-time", daemon=True)
        # { "YYYY-MM-DD": {"active_seconds": int, "screen_on_count": int} }
        self._daily: dict[str, dict[str, int]] = {}
        # { "YYYY-MM-DD": { process_name: {"seconds": int, "last_used": datetime} } }
        self._app_daily: dict[str, dict[str, dict]] = {}
        self._was_active = False
        self._is_active = False
        self._last_on_at: datetime | None = None
        self._last_off_at: datetime | None = None

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(SAMPLE_INTERVAL_SECONDS):
            try:
                self._sample()
            except Exception:
                # Satu sampel gagal tidak boleh mematikan thread; lewati saja.
                # (Tidak ada data sensitif untuk dicatat di sini.)
                continue

    def _sample(self) -> None:
        now = datetime.now()
        active = _idle_seconds() < IDLE_THRESHOLD_SECONDS
        today = now.date().isoformat()

        with self._lock:
            self._prune(now.date())
            day = self._daily.setdefault(today, {"active_seconds": 0, "screen_on_count": 0})

            if active:
                day["active_seconds"] += SAMPLE_INTERVAL_SECONDS
                if not self._was_active:
                    # Transisi diam -> aktif dihitung sebagai satu "layar dinyalakan".
                    day["screen_on_count"] += 1
                    self._last_on_at = now
                process_name = _foreground_process_name()
                if process_name:
                    apps = self._app_daily.setdefault(today, {})
                    entry = apps.setdefault(process_name, {"seconds": 0, "last_used": now})
                    entry["seconds"] += SAMPLE_INTERVAL_SECONDS
                    entry["last_used"] = now
            elif self._was_active:
                self._last_off_at = now

            self._was_active = active
            self._is_active = active

    def _prune(self, today: date) -> None:
        keep = {today.isoformat()}
        for offset in range(1, RETAINED_DAYS):
            keep.add(date.fromordinal(today.toordinal() - offset).isoformat())
        for store in (self._daily, self._app_daily):
            for key in list(store.keys()):
                if key not in keep:
                    del store[key]

    def snapshot(self) -> dict:
        """Potret saat ini untuk dimasukkan ke payload (sudah thread-safe)."""
        with self._lock:
            screen_time_daily = [
                {
                    "date": day,
                    "screenOnSeconds": values["active_seconds"],
                    "screenOnCount": values["screen_on_count"],
                }
                for day, values in sorted(self._daily.items())
            ]
            app_usage_daily = []
            for day, apps in sorted(self._app_daily.items()):
                for name, entry in apps.items():
                    if entry["seconds"] <= 0:
                        continue
                    app_usage_daily.append(
                        {
                            "date": day,
                            "packageName": name,
                            "appLabel": name,
                            "foregroundSeconds": entry["seconds"],
                            "lastUsedAt": entry["last_used"].astimezone().isoformat(),
                        }
                    )
            return {
                "isScreenOn": self._is_active,
                "lastOnAt": self._last_on_at.astimezone().isoformat() if self._last_on_at else None,
                "lastOffAt": self._last_off_at.astimezone().isoformat() if self._last_off_at else None,
                "screenTimeDaily": screen_time_daily,
                "appUsageDaily": app_usage_daily,
            }


def _battery() -> dict:
    try:
        battery = psutil.sensors_battery()
    except Exception:
        battery = None
    if battery is None:
        # PC desktop tanpa baterai -> semua null (bukan 0, biar tidak salah baca).
        return {
            "level": None,
            "isCharging": None,
            "chargerType": None,
            "temperatureCelsius": None,
            "health": None,
        }
    return {
        "level": int(battery.percent),
        "isCharging": bool(battery.power_plugged),
        # Windows tidak membedakan jenis charger seperti Android.
        "chargerType": "ac" if battery.power_plugged else None,
        "temperatureCelsius": None,
        "health": None,
    }


def _network() -> dict:
    net_type = "none"
    try:
        stats = psutil.net_if_stats()
        up_names = [name for name, info in stats.items() if info.isup]
        if any(("wi-fi" in n.lower() or "wireless" in n.lower() or "wlan" in n.lower()) for n in up_names):
            net_type = "wifi"
        elif up_names:
            net_type = "ethernet"
    except Exception:
        pass
    return {
        "type": net_type,
        "wifiSsid": None,
        "signalLevel": None,
        "carrierName": None,
        "isAirplaneMode": None,
        "isGpsEnabled": None,
    }


def _device_info(app_version: str) -> dict:
    try:
        total, _, free = shutil.disk_usage("C:\\")
    except OSError:
        total = free = 0
    memory = psutil.virtual_memory()
    try:
        uptime = int(time.time() - psutil.boot_time())
    except Exception:
        uptime = 0
    return {
        "brand": _registry_value(r"HARDWARE\DESCRIPTION\System\BIOS", "SystemManufacturer"),
        "model": _registry_value(r"HARDWARE\DESCRIPTION\System\BIOS", "SystemProductName"),
        # Field 'androidVersion' di kontrak dipakai untuk versi OS apa pun;
        # untuk PC diisi versi Windows.
        "androidVersion": f"Windows {platform.release()}",
        "appVersion": app_version,
        "storageFreeBytes": int(free),
        "storageTotalBytes": int(total),
        "ramFreeBytes": int(memory.available),
        "ramTotalBytes": int(memory.total),
        "uptimeSeconds": uptime,
    }


def build_status_report(app_version: str, screen_tracker: ScreenTimeTracker) -> dict:
    """Payload lengkap sesuai docs/kontrak-status-perangkat.md bagian 1."""
    screen = screen_tracker.snapshot()
    return {
        "recordedAt": datetime.now().astimezone().isoformat(),
        "battery": _battery(),
        "network": _network(),
        "device": _device_info(app_version),
        "screen": {
            "isScreenOn": screen["isScreenOn"],
            "lastOnAt": screen["lastOnAt"],
            "lastOffAt": screen["lastOffAt"],
        },
        # PC dipantau hanya saat agen terlihat berjalan; pemakaian per aplikasi
        # selalu tersedia tanpa izin khusus seperti di Android.
        "isUsageAccessGranted": True,
        "screenTimeDaily": screen["screenTimeDaily"],
        "appUsageDaily": screen["appUsageDaily"],
    }
