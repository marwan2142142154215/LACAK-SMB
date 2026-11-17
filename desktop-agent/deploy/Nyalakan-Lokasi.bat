@echo off
rem Nyalakan Layanan Lokasi Windows untuk Lacak SMB Agent: klik dua kali file ini.
rem Otomatis meminta izin Administrator. Panduan: BACA-DULU.txt
setlocal
net session >nul 2>&1
if errorlevel 1 (
    echo Meminta izin Administrator...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nyalakan-lokasi.ps1"
echo.
pause
