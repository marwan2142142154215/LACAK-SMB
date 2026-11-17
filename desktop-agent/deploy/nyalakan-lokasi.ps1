<#
.SYNOPSIS
    Nyalakan Layanan Lokasi Windows untuk Lacak SMB Agent (pelacak lokasi PC).

.DESCRIPTION
    Dijalankan sekali per PC sebagai Administrator (lewat Nyalakan-Lokasi.bat, klik dua kali).
    Menyetel registry agar "Layanan lokasi" dan "Biarkan aplikasi desktop mengakses lokasi"
    menyala, menghapus kebijakan yang mematikan lokasi, lalu memastikan service Geolocation
    (lfsvc) berjalan. Windows tidak mengizinkan aplikasi biasa melakukan ini sendiri (privasi),
    jadi langkah ini perlu Administrator. Untuk banyak PC domain, sebar lewat Group Policy /
    Intune (lihat BACA-DULU.txt).

.PARAMETER Uninstall
    Kembalikan izin lokasi ke "Deny" (jarang dipakai).
#>
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$value = if ($Uninstall) { 'Deny' } else { 'Allow' }
$CONSENT = 'SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Set izin lokasi (master + aplikasi desktop/NonPackaged) di satu hive registry.
function Set-Consent($root, $label) {
    $path = Join-Path $root $CONSENT
    New-Item -Path $path -Force | Out-Null
    Set-ItemProperty -Path $path -Name 'Value' -Value $value
    $np = Join-Path $path 'NonPackaged'
    New-Item -Path $np -Force | Out-Null
    Set-ItemProperty -Path $np -Name 'Value' -Value $value
    Write-Host ("    {0,-26} {1}" -f $label, $value)
}

Write-Host ''
Write-Host '  Lacak SMB - nyalakan Lokasi Windows' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Admin)) {
    Write-Host '  Gagal: jalankan sebagai Administrator (klik dua kali Nyalakan-Lokasi.bat).' -ForegroundColor Red
    exit 1
}

# 1. Izin lokasi se-perangkat (berlaku untuk semua user).
Set-Consent 'HKLM:\' 'Perangkat (semua user)'

# 2. Izin lokasi untuk user yang sedang login -- ditulis ke hive SID-nya, bukan HKCU admin
#    (skrip jalan sebagai Administrator, HKCU di sini = milik admin, bukan staf).
$consoleUser = $null
try { $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName } catch {}
if ($consoleUser) {
    try {
        $sid = (New-Object System.Security.Principal.NTAccount($consoleUser)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
        Set-Consent "Registry::HKEY_USERS\$sid\" "User ($consoleUser)"
    } catch {
        Write-Host ("    User ({0}) dilewati: {1}" -f $consoleUser, $_.Exception.Message) -ForegroundColor Yellow
    }
} else {
    Write-Host '    User aktif tak terdeteksi -- jalankan sekali saat staf sudah login.' -ForegroundColor Yellow
}

# 3. Hapus kebijakan yang memaksa lokasi mati (kalau pernah diset IT/GPO).
$pol = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\LocationAndSensors'
if ((Test-Path $pol) -and (-not $Uninstall)) {
    foreach ($n in 'DisableLocation', 'DisableLocationScripting', 'DisableWindowsLocationProvider') {
        try {
            if ($null -ne (Get-ItemProperty -Path $pol -Name $n -ErrorAction Stop).$n) {
                Set-ItemProperty -Path $pol -Name $n -Value 0
                Write-Host ("    Kebijakan {0} -> 0" -f $n)
            }
        } catch {}
    }
}

# 4. Pastikan service Geolocation (lfsvc) berjalan otomatis.
if (-not $Uninstall) {
    try {
        Set-Service -Name 'lfsvc' -StartupType Automatic -ErrorAction Stop
        Start-Service -Name 'lfsvc' -ErrorAction SilentlyContinue
        Write-Host '    Service Geolocation (lfsvc)  otomatis + jalan'
    } catch {
        Write-Host ("    Service lfsvc: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
    }
}

Write-Host ''
if ($Uninstall) {
    Write-Host '  Selesai: izin lokasi dikembalikan ke Deny.' -ForegroundColor Green
} else {
    Write-Host '  Selesai: Lokasi Windows menyala.' -ForegroundColor Green
    Write-Host '  Buka / buka-ulang Lacak SMB Agent -- layar "Aktifkan lokasi" tidak muncul lagi.'
}
exit 0
