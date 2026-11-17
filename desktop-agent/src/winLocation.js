'use strict'

const { spawn } = require('node:child_process')

/**
 * Lokasi dari Windows Location Service lewat WinRT (Windows.Devices.Geolocation),
 * dijalankan di main process lewat PowerShell.
 *
 * Kenapa bukan navigator.geolocation (renderer/Chromium)? Di Electron, Chromium
 * butuh Google API key untuk penyedia lokasi jaringan dan tidak andal memakai
 * layanan lokasi Windows -> sering mengembalikan POSITION_UNAVAILABLE walau izin
 * aktif. WinRT memakai GPS/WiFi perangkat (bukan IP) -> tahan-VPN, tanpa API key.
 * Proses jalan di sesi interaktif user, jadi memakai izin "aplikasi desktop" yang
 * sama (ConsentStore -> Allow).
 *
 * Mengembalikan { ok, latitude, longitude, accuracy } atau { ok:false, code, message }.
 */

const PS = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    "$as=[System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'}|Select-Object -First 1",
    'function Await($o,$t){$m=$as.MakeGenericMethod($t);$k=$m.Invoke($null,@($o));[void]$k.Wait(20000);$k.Result}',
    '[Windows.Devices.Geolocation.Geolocator,Windows.Devices.Geolocation,ContentType=WindowsRuntime]|Out-Null',
    "$st=Await ([Windows.Devices.Geolocation.Geolocator]::RequestAccessAsync()) ([Windows.Devices.Geolocation.GeolocationAccessStatus])",
    "if($st -ne 'Allowed'){Write-Output ('ERR '+$st);exit 0}",
    '$g=New-Object Windows.Devices.Geolocation.Geolocator',
    '$g.DesiredAccuracyInMeters=30',
    '$p=Await ($g.GetGeopositionAsync()) ([Windows.Devices.Geolocation.Geoposition])',
    '$c=$p.Coordinate',
    "Write-Output ('OK '+$c.Point.Position.Latitude+' '+$c.Point.Position.Longitude+' '+$c.Accuracy)",
].join('\n')

function getWindowsLocation(timeoutMs = 25000) {
    return new Promise((resolve) => {
        let ps
        try {
            ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS], {
                windowsHide: true,
            })
        } catch (err) {
            return resolve({ ok: false, code: 0, message: `PowerShell tak bisa dijalankan: ${err.message}` })
        }
        let out = ''
        let errout = ''
        const timer = setTimeout(() => {
            try {
                ps.kill()
            } catch {
                // sudah mati
            }
            resolve({ ok: false, code: 3, message: 'Lokasi timeout, mencoba lagi' })
        }, timeoutMs)

        ps.stdout.on('data', (d) => (out += d.toString()))
        ps.stderr.on('data', (d) => (errout += d.toString()))
        ps.on('error', (err) => {
            clearTimeout(timer)
            resolve({ ok: false, code: 0, message: `PowerShell gagal: ${err.message}` })
        })
        ps.on('close', () => {
            clearTimeout(timer)
            const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || ''
            if (line.startsWith('OK ')) {
                const [, lat, lon, acc] = line.split(' ')
                const latitude = Number(lat)
                const longitude = Number(lon)
                const accuracy = Number(acc)
                if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
                    return resolve({ ok: true, latitude, longitude, accuracy: Number.isFinite(accuracy) ? accuracy : null })
                }
                return resolve({ ok: false, code: 2, message: 'Format lokasi tak terbaca' })
            }
            if (line.startsWith('ERR ')) {
                return resolve({ ok: false, code: 1, message: `Izin lokasi Windows ditolak (${line.slice(4).trim()})` })
            }
            const firstErr = errout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
            return resolve({ ok: false, code: 2, message: firstErr || 'Lokasi tidak tersedia (layanan lokasi Windows mati?)' })
        })
    })
}

module.exports = { getWindowsLocation }
