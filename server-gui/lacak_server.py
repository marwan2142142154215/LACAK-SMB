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
# TANPA ini, setiap child process (php/npm.cmd/cloudflared) membuka jendela
# cmd sendiri-sendiri -- CREATE_NEW_PROCESS_GROUP saja cuma bikin grup proses
# baru (buat kirim CTRL_BREAK), TIDAK menyembunyikan window. CREATE_NO_WINDOW
# yang benar-benar mencegah window konsol muncul sama sekali; stdout/stderr
# tetap mengalir ke panel log lewat PIPE seperti biasa, tidak ada yang hilang.
CREATE_NO_WINDOW = 0x08000000
POPEN_FLAGS = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

SERVICES = [
    # (id, label, cwd(repos), command, port_or_None)
    # WAJIB paling atas & paling duluan start: Postgres (dan Redis) untuk
    # proyek ini jalan DI DALAM WSL2 (distro Ubuntu), bukan service Windows
    # asli. WSL2 TERNYATA mematikan VM-nya sendiri begitu tidak ada proses
    # wsl.exe yang masih "nempel" ke distro itu -- ditemukan lewat
    # pengamatan langsung: PID postgres berganti-ganti dalam hitungan detik,
    # `wsl -l -v` sempat menunjukkan Ubuntu "Stopped" cuma beberapa detik
    # setelah sebelumnya "Running". vmIdleTimeout=-1 di .wslconfig semestinya
    # mematikan perilaku ini, tapi butuh service WSLService di-restart
    # (perlu admin) atau Windows di-restart penuh supaya kebaca -- "sleep
    # infinity" di sini jauh lebih sederhana: proses wsl.exe yang sengaja
    # tidak pernah selesai, jadi distro-nya selalu "nempel"/hidup selama
    # service ini jalan, tanpa perlu ubah apa pun di level Windows.
    ("wsl-keepalive", "WSL2 Keep-Alive (Postgres/Redis host)", ".",
     ["wsl.exe", "-d", "Ubuntu", "sleep", "infinity"], None),
    # Port 8000/8080 WAJIB sama persis dengan yang ditunggu Cloudflare Tunnel
    # (lihat config remote tunnel LACAKSMB: api.->* :8000, app.->*:8080) --
    # jangan diubah sendiri-sendiri tanpa mengubah tunnel-nya juga.
    ("backend", "Backend API (Laravel :8000)", "backend-api",
     ["php", "artisan", "serve", "--host=127.0.0.1", "--port=8000"], 8000),
    ("queue", "Antrean Build APK (queue:work)", "backend-api",
     ["php", "artisan", "queue:work", "--tries=1", "--timeout=310"], None),
    # "npm start" -> node bin/server.js yang TIDAK ADA (proyek ini TypeScript
    # murni, belum pernah di-build) -- "npm run dev" yang menjalankan
    # bin/server.ts via AdonisJS ace serve, sama seperti dipakai sepanjang
    # pengembangan proyek ini.
    ("gateway", "Realtime Gateway (:3333)", "realtime-gateway",
     ["npm.cmd", "run", "dev"], 3333),
    # SENGAJA "vite preview" (serve dist/ hasil build) BUKAN "vite dev" --
    # dev server itu kirim ratusan modul JS mentah belum di-bundle/minify ke
    # browser satu-satu, lewat Cloudflare Tunnel itu jadi lag parah waktu
    # pertama buka web (diukur langsung: HMR websocket-nya pun sempat
    # "connection lost, polling for restart" di console produksi). "preview"
    # cuma serve beberapa file dist/ yang sudah di-bundle+minify -- jauh
    # lebih cepat & stabil untuk dipakai publik. Konsekuensinya: perubahan
    # kode BARU terlihat di web setelah `npm run build` dijalankan ulang di
    # web-dashboard/ (tidak live-reload otomatis lagi seperti dev server).
    ("dashboard", "Web Dashboard (Vite preview :8080)", "web-dashboard",
     ["npm.cmd", "run", "preview", "--", "--port", "8080", "--host", "127.0.0.1"], 8080),
    ("telegram-bot", "Telegram Bot", "telegram-bot",
     ["npm.cmd", "start"], None),
    ("tunnel", "Cloudflare Tunnel", ".",
     ["cloudflared.exe", "tunnel", "--no-autoupdate", "run"], None),
]

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# backend, queue, dan gateway semua butuh Postgres (WSL2) hidup duluan --
# WSL2 TIDAK auto-start bareng Windows, dan port forwarding-nya ke Windows
# baru siap beberapa detik setelah WSL2 sendiri bangun. Tanpa menunggu ini,
# ketiga layanan itu selalu race ke port 5432 yang masih "connection refused"
# tepat setelah PC baru nyala -- persis yang berulang kali teramati (backend
# gagal konek DB, queue:work crash exit 1 "connection refused"). Menunggu di
# sini sekali di awal jauh lebih murah/jelas daripada menambal tiap layanan.
POSTGRES_PORT = 5432
DB_DEPENDENT_SERVICES = {"backend", "queue", "gateway"}

# Berapa kali boleh auto-restart sendiri sebelum menyerah (anggap error
# menetap, bukan sekadar koneksi WSL2 yang sempat putus sesaat -- pernah
# teramati juga: queue:work crash di tengah jalan karena "SSL SYSCALL error:
# Software caused connection abort", semata blip jaringan WSL2<->Windows,
# bukan bug di kode). Reset terhitung ulang tiap kali Start ditekan manual.
MAX_AUTO_RESTARTS = 5
AUTO_RESTART_DELAY_MS = 3000


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
        # Ditandai SEBELUM stop_service mematikan proses, supaya _pump tahu
        # "proses berhenti" ini sengaja (jangan auto-restart) vs crash sendiri
        # (boleh auto-restart). Dibersihkan lagi oleh stop_service setelah
        # taskkill selesai supaya start manual berikutnya tidak ikut ketandai.
        self._user_stopped: set[str] = set()
        self._restart_count: dict[str, int] = {}

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
        self.log.tag_config("wsl-keepalive", foreground="#94a3b8")
        self.log.tag_config("backend", foreground="#60a5fa")
        self.log.tag_config("queue", foreground="#38bdf8")
        self.log.tag_config("gateway", foreground="#a78bfa")
        self.log.tag_config("dashboard", foreground="#34d399")
        self.log.tag_config("telegram-bot", foreground="#fbbf24")
        self.log.tag_config("tunnel", foreground="#f472b6")
        self.log.tag_config("sys", foreground="#f87171")

        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(200, self._scan_ports_once)
        self.after(200, self._drain_queue)

    # --- logging ------------------------------------------------------------
    def println(self, sid: str, text: str):
        lines = ANSI.sub("", text).splitlines() or [""]
        self.log.config(state="normal")
        for line in lines:
            self.log.insert("end", f"[{sid:>7}] " + line + "\n", sid if sid in ("wsl-keepalive", "backend", "queue", "gateway", "dashboard", "telegram-bot", "tunnel") else "sys")
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

    def start_service(self, sid: str, _is_auto_restart: bool = False):
        if self._procs.get(sid) and self._procs[sid].poll() is None:
            self.println(sid, "Sudah berjalan.")
            return
        self._user_stopped.discard(sid)
        if not _is_auto_restart:
            # Start manual (tombol/"Mulai Semua") = niat baru, bukan lanjutan
            # dari rangkaian crash sebelumnya -- hitung ulang dari nol supaya
            # auto-restart tidak kehabisan jatah gara-gara kegagalan lama.
            self._restart_count[sid] = 0
        _, label, cwd, cmd, port = self._svc(sid)
        if port and port_in_use(port):
            self.println(sid, f"Port {port} sudah terpakai — asumsi layanan sudah jalan di luar panel.")
            self.rows[[r.sid for r in self.rows].index(sid)].set_state("running")
            return
        self.rows[[r.sid for r in self.rows].index(sid)].set_state("starting")
        if sid in DB_DEPENDENT_SERVICES:
            # Jangan langsung Popen -- tunggu dulu Postgres (WSL2) benar-benar
            # bisa dihubungi. WSL2 perlu waktu beberapa detik untuk bangun dan
            # port-forward-nya ke Windows siap; tanpa menunggu ini, backend/
            # queue/gateway selalu race dan gagal connect di percobaan
            # pertama tepat setelah PC baru nyala.
            self.println(sid, "-> menunggu Postgres (WSL2) siap...")
            threading.Thread(target=self._wait_then_launch, args=(sid, label, cwd, cmd, port), daemon=True).start()
            return
        self._launch(sid, label, cwd, cmd, port)

    def _wait_then_launch(self, sid: str, label: str, cwd, cmd, port):
        import time
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if port_in_use(POSTGRES_PORT):
                self._println_threadsafe(sid, "-> Postgres siap, melanjutkan start.")
                self.after(0, lambda: self._launch(sid, label, cwd, cmd, port))
                return
            time.sleep(1)
        self._println_threadsafe(sid, "-> Postgres tidak kunjung siap dalam 30 detik, tetap mencoba start...")
        self.after(0, lambda: self._launch(sid, label, cwd, cmd, port))

    def _launch(self, sid: str, label: str, cwd, cmd, port):
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(cwd),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, errors="replace", bufsize=1,
                creationflags=POPEN_FLAGS,
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
        # Ditandai SEBELUM taskkill supaya _pump/_drain_queue tahu proses ini
        # berhenti karena memang diminta, bukan crash -- jangan auto-restart.
        self._user_stopped.add(sid)
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
                self._handle_process_exit(text)
            else:
                self.println(sid, text)
        self.after(150, self._drain_queue)

    def _handle_process_exit(self, sid: str):
        try:
            row = self.rows[[r.sid for r in self.rows].index(sid)]
        except ValueError:
            return
        if sid in self._user_stopped:
            # Sudah ditandai stopped oleh stop_service sendiri -- ini cuma
            # event _pump yang menyusul belakangan, jangan ditimpa/di-restart.
            return
        count = self._restart_count.get(sid, 0)
        if count >= MAX_AUTO_RESTARTS:
            row.set_state("error")
            self.println(sid, f"-- berhenti sendiri {count}x berturut-turut, menyerah auto-restart. Tekan Start manual kalau sudah yakin masalahnya teratasi.")
            return
        self._restart_count[sid] = count + 1
        row.set_state("error")
        self.println(sid, f"-- berhenti sendiri (bukan diminta) -- auto-restart #{count + 1}/{MAX_AUTO_RESTARTS} dalam {AUTO_RESTART_DELAY_MS // 1000} detik...")
        self.after(AUTO_RESTART_DELAY_MS, lambda: self.start_service(sid, _is_auto_restart=True))

    def _on_close(self):
        self.stop_all()
        self.destroy()


if __name__ == "__main__":
    ServerController().mainloop()
