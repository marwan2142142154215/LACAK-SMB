@echo off
rem Hapus kebijakan Chrome & Edge Live Kerja dari laptop ini: klik dua kali file ini.
rem Hanya entri milik Live Kerja yang dihapus; aturan IT lain dibiarkan.
setlocal
net session >nul 2>&1
if errorlevel 1 (
    echo Meminta izin Administrator...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0live-kerja-browser.ps1" -Uninstall
echo.
pause
