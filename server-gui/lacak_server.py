"""
Lacak SMB Server Controller
===========================

Kontrol panel untuk menyalakan, mengehentikan, dan melihat log dari empat
layanan:

  1. Backend API       (Laravel)  -> php artisan serve --port 8010
  2. Realtime Gateway  (AdonisJS) -> npm start           -> :3333
  3. Web Dashboard     (Vite)     -> npm run dev
  4. Telegram Bot                 -> node src/index.js

Jalan via double-click pada `lacak-server.exe` (atau `python lacak_server.py`
selama masih fase pengembangan).
"""

from __future__ import annotations

import os
import queue
import re
import socket
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import ttk


def _find_repo_root() -> Path:
    """Cari akar repo (folder yang berisi backend-api + realtime-gateway)."""
    if getattr(sys, "frozen", False):
        seed = Path(sys.executable).resolve().parent
    else:
        seed = Path(__file__).resolve().parent
    cwd = Path.cwd()
    for start in (seed, cwd):
        cur = start
        while True:
            if (cur / "backend-api").is_dir() and (cur / "realtime-gateway").is_dir():
                return cur
            if cur.parent == cur:
                break
            cur = cur.parent
    return seed


REPO_ROOT = _find_repo_root()

CREATE_NEW_PROCESS_GROUP = 0x00000200

SERVICES = [
    # (id, label, cwd(repos), command, port_or_None)
    ("backend", "Backend API (Laravel :8010)", "backend-api",
     ["php", "artisan", "serve", "--host=127.0.0.1", "--port=8010"], 8010),
    ("gateway", "Realtime Gateway (:3333)", "realtime-gateway",
     ["npm.cmd", "start"], 3333),
    ("dashboard", "Web Dashboard (Vite)", "web-dashboard",
     ["npm.cmd", "run", "dev"], 5173),
    ("telegram-bot", "Telegram Bot", "telegram-bot",
     ["npm.cmd", "start"], None),
    ("tunnel", "Cloudflare Tunnel", ".",
     ["cloudflared.exe", "tunnel", "--no-autoupdate", "run"], None),
]

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


class ServiceRow:
    def __init__(self, canvas: tk.Widget, idx: int, sid: str, label: str):
        self.sid = sid
        self.label = label
        self.frame = ttk.Frame(canvas)
        self.frame.grid(row=idx, column=0, sticky="w", padx=10, pady=6, columnspan=4)
        dot = tk.Canvas(self.frame, width=14, height=14, highlightthickness=0)
        dot.grid(row=0, column=0, padx=(0, 10))
        self._dot_id = dot.create_oval(2, 2, 12, 12, fill="#6b7280", outline="")
        self.dot = dot
        tk.Label(self.frame, text=label, width=36, anchor="w", font=("Segoe UI", 10)).grid(row=0, column=1, sticky="w")
        self.btn_start = ttk.Button(self.frame, text="Start", width=8)
        self.btn_start.grid(row=0, column=2, padx=4)
        self.btn_stop = ttk.Button(self.frame, text="Stop", width=8, state="disabled")
        self.btn_stop.grid(row=0, column=3, padx=4)

    def set_state(self, state: str):
        palette = {"stopped": "#6b7280", "starting": "#f59e0b", "running": "#22c55e",
                   "error": "#ef4444"}
        self.dot.itemconfig(self._dot_id, fill=palette.get(state, "#6b7280"))
        if state == "running":
            self.btn_start.config(state="disabled")
            self.btn_stop.config(state="normal")
        else:
            self.btn_start.config(state="normal")
            self.btn_stop.config(state="disabled")


class StationLog:
    GREEN = "#4ade80"
    AMBER = "#fbbf24"
    RED = "#f87171"


class ServerController(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Lacak SMB — Server Controller")
        self.geometry("940x620")
        self.configure(bg="#0f172a")
        self._procs: dict[str, subprocess.Popen | None] = {}
        self._queue: queue.Queue[tuple[str, str]] = queue.Queue()

        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TButton", padding=(10, 4))

        header = tk.Label(self, text="Lacak SMB — Server Controller",
                          bg="#0f172a", fg="#e2e8f0",
                          font=("Segoe UI Semibold", 14))
        header.pack(anchor="w", padx=16, pady=(14, 4))
        sub = tk.Label(self, text="Kontrol proses backend / gateway / dashboard / bot — log realtime",
                       bg="#0f172a", fg="#64748b", font=("Segoe UI", 9))
        sub.pack(anchor="w", padx=16, pady=(0, 8))

        rows_frame = tk.LabelFrame(self, text=" Layanan ", bg="#111827", fg="#cbd5e1",
                                   font=("Segoe UI Semibold", 10), bd=1, relief="groove")
        rows_frame.pack(fill="x", padx=16, pady=4)
        self.rows: list[ServiceRow] = []
        for i, (sid, label, subdir, cmd, port) in enumerate(SERVICES):
            row = ServiceRow(rows_frame, i, sid, label)
            row.btn_start.config(command=lambda s=sid: self.start_service(s))
            row.btn_stop.config(command=lambda s=sid: self.stop_service(s))
            self.rows.append(row)

        actions = tk.Frame(self, bg="#0f172a")
        actions.pack(fill="x", padx=16, pady=(6, 0))
        ttk.Button(actions, text="Mulai Semua", command=self.start_all).pack(side="left")
        ttk.Button(actions, text="Halaman Verifikasi", command=self._print_ping).pack(side="left", padx=6)
        ttk.Button(actions, text="Matikan Semua", command=self.stop_all).pack(side="right")

        log_frame = tk.Frame(self, bg="#0f172a")
        log_frame.pack(fill="both", expand=True, padx=16, pady=(8, 14))
        self.log = tk.Text(log_frame, bg="#020617", fg="#e2e8f0", insertbackground="#e2e8f0",
                           font=("Consolas", 9), wrap="word", state="disabled", undo=False)
        self.log.pack(side="left", fill="both", expand=True)
        scroll = ttk.Scrollbar(log_frame, command=self.log.yview)
        scroll.pack(side="right", fill="y")
        self.log.config(yscrollcommand=scroll.set)
        self.log.tag_config("backend", foreground="#60a5fa")
        self.log.tag_config("gateway", foreground="#a78bfa")
        self.log.tag_config("dashboard", foreground="#34d399")
        self.log.tag_config("telegram-bot", foreground="#fbbf24")
        self.log.tag_config("sys", foreground="#f87171")

        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(200, self._scan_ports_once)
        self.after(200, self._drain_queue)

    # --- logging ------------------------------------------------------------
    def println(self, sid: str, text: str):
        lines = ANSI.sub("", text).splitlines() or [""]
        self.log.config(state="normal")
        for line in lines:
            self.log.insert("end", f"[{sid:>7}] " + line + "\n", sid if sid in ("backend", "gateway", "dashboard", "telegram-bot") else "sys")
        self.log.see("end")
        self.log.config(state="disabled")

    def _println_threadsafe(self, sid: str, text: str):
        self._queue.put((sid, text))

    # --- service control ----------------------------------------------------
    def _svc(self, sid: str):
        for sid2, label, subdir, cmd, port in SERVICES:
            if sid2 == sid:
                return (sid2, label, REPO_ROOT / subdir, cmd, port)
        raise KeyError(sid)

    def start_service(self, sid: str):
        if self._procs.get(sid) and self._procs[sid].poll() is None:
            self.println(sid, "Sudah berjalan.")
            return
        _, label, cwd, cmd, port = self._svc(sid)
        if port and port_in_use(port):
            self.println(sid, f"Port {port} sudah terpakai — asumsi layanan sudah jalan di luar panel.")
            self.rows[[r.sid for r in self.rows].index(sid)].set_state("running")
            return
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(cwd),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, errors="replace", bufsize=1,
                creationflags=CREATE_NEW_PROCESS_GROUP,
            )
        except FileNotFoundError as exc:
            self.println(sid, f"Gagal start: {exc}")
            self.rows[[r.sid for r in self.rows].index(sid)].set_state("error")
            return
        self._procs[sid] = proc
        self.rows[[r.sid for r in self.rows].index(sid)].set_state("starting")
        self.println(sid, f"-> memulai: {' '.join(cmd)}")
        threading.Thread(target=self._pump, args=(proc, sid, port), daemon=True).start()
        self.after(1500, lambda: self._mark_running_if_alive(sid, proc))

    def _mark_running_if_alive(self, sid: str, proc: subprocess.Popen):
        if proc.poll() is None:
            try:
                self.rows[[r.sid for r in self.rows].index(sid)].set_state("running")
            except ValueError:
                pass

    def _pump(self, proc: subprocess.Popen, sid: str, port: int | None):
        for line in proc.stdout:  # type: ignore[union-attr]
            self._println_threadsafe(sid, line.rstrip("\n"))
        rc = proc.wait()
        self._println_threadsafe(sid, f"-- proses berhenti (exit {rc}).")
        self._queue.put(("__state__", sid))

    def stop_service(self, sid: str):
        proc = self._procs.get(sid)
        if not proc or proc.poll() is not None:
            self.println(sid, "Tidak ada proses aktif.")
            return
        try:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                           check=False, capture_output=True)
        finally:
            self._procs[sid] = None
            self.rows[[r.sid for r in self.rows].index(sid)].set_state("stopped")
            self.println(sid, "-- dihentikan.")

    def start_all(self):
        for (sid, *_rest) in SERVICES:
            self.start_service(sid)

    def stop_all(self):
        for (sid, *_rest) in SERVICES:
            self.stop_service(sid)

    def _scan_ports_once(self):
        for (_sid, _label, _sub, _cmd, port), row in zip(SERVICES, self.rows):
            row.set_state("running" if port and port_in_use(port) else "stopped")

    def _print_ping(self):
        self.println("sys", "Panel kontrol Lacak SMB siap 👌 — semua layanan dapat di-start/stop & dilihat lognya.")

    def _drain_queue(self):
        while not self._queue.empty():
            sid, text = self._queue.get_nowait()
            if sid == "__state__":
                try:
                    row = self.rows[[r.sid for r in self.rows].index(text)]
                    row.set_state("stopped")
                except ValueError:
                    pass
            else:
                self.println(sid, text)
        self.after(150, self._drain_queue)

    def _on_close(self):
        self.stop_all()
        self.destroy()


if __name__ == "__main__":
    ServerController().mainloop()
