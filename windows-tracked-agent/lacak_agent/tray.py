"""Ikon tray yang terlihat -- penanda bahwa PC ini dipantau sebagai aset.

Menampilkan status koneksi, ID device (untuk didaftarkan admin), sakelar jalan
otomatis, pemberitahuan isi pemantauan, dan tombol keluar. Kehadiran ikon ini
disengaja: pengguna PC selalu tahu agen aktif.
"""

from __future__ import annotations

import tkinter
from pathlib import Path

import pystray
from PIL import Image, ImageDraw

from . import autostart
from .app import AgentApp

MONITORING_NOTICE = (
    "PC ini adalah aset perusahaan dan dipantau oleh sistem LACAK-SMB.\n\n"
    "Yang dikumpulkan: status baterai & daya, jenis jaringan, info PC "
    "(merek/model, versi Windows, penyimpanan, RAM, lama nyala), lama layar "
    "aktif, serta nama aplikasi yang dipakai dan durasinya.\n\n"
    "Yang TIDAK dikumpulkan: ketikan, tangkapan layar, judul jendela, isi "
    "aplikasi/chat/email, kamera, maupun mikrofon."
)


def _build_icon_image() -> Image.Image:
    image = Image.new("RGB", (64, 64), (17, 24, 39))
    draw = ImageDraw.Draw(image)
    draw.ellipse((14, 14, 50, 50), outline=(96, 165, 250), width=5)
    draw.ellipse((28, 28, 36, 36), fill=(96, 165, 250))
    return image


def _copy_to_clipboard(text: str) -> None:
    root = tkinter.Tk()
    root.withdraw()
    root.clipboard_clear()
    root.clipboard_append(text)
    root.update()  # pastikan clipboard terisi sebelum root ditutup
    root.destroy()


class TrayApp:
    def __init__(self, config_path: Path) -> None:
        self._agent = AgentApp(config_path, on_state=self._on_state)
        self._icon = pystray.Icon(
            "lacak-smb-agent",
            icon=_build_icon_image(),
            title="LACAK-SMB: memulai...",
            menu=self._build_menu(),
        )

    def _build_menu(self) -> pystray.Menu:
        return pystray.Menu(
            pystray.MenuItem(lambda item: f"Status: {self._agent.status}", None, enabled=False),
            pystray.MenuItem(lambda item: f"ID Device: {self._agent.device_uuid}", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Salin ID Device", self._on_copy_id),
            pystray.MenuItem(
                "Jalan otomatis saat login",
                self._on_toggle_autostart,
                checked=lambda item: autostart.is_enabled(),
            ),
            pystray.MenuItem("Pemberitahuan pemantauan", self._on_show_notice),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Keluar", self._on_quit),
        )

    def _on_state(self, status: str) -> None:
        self._icon.title = f"LACAK-SMB: {status}"
        try:
            self._icon.update_menu()
        except Exception:
            # Menu belum siap sebelum icon.run(); abaikan.
            pass

    def _on_copy_id(self, _icon, _item) -> None:
        _copy_to_clipboard(self._agent.device_uuid)
        self._icon.notify("ID Device disalin ke clipboard", "LACAK-SMB")

    def _on_toggle_autostart(self, _icon, _item) -> None:
        if autostart.is_enabled():
            autostart.disable()
        else:
            autostart.enable()

    def _on_show_notice(self, _icon, _item) -> None:
        self._icon.notify(MONITORING_NOTICE, "Pemberitahuan pemantauan")

    def _on_quit(self, _icon, _item) -> None:
        self._agent.stop()
        self._icon.stop()

    def run(self) -> None:
        # Agen jalan di thread latar; tray memblokir di thread utama.
        if autostart.is_enabled() is False:
            autostart.enable()  # default sesuai pilihan deploy: aktif saat login
        self._agent.start()
        self._icon.run()
