@echo off
rem Pasang kebijakan Chrome & Edge kantor untuk Live Kerja: klik dua kali file ini.
rem Otomatis meminta izin Administrator. Panduan: docs/chrome-kantor.md
setlocal
net session >nul 2>&1
if errorlevel 1 (
    echo Meminta izin Administrator...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0live-kerja-browser.ps1"
echo.
pause
