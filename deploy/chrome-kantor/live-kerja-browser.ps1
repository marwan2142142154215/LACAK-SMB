<#
.SYNOPSIS
    Pasang atau hapus kebijakan Chrome & Edge kantor untuk Live Kerja.

.DESCRIPTION
    Dijalankan lewat Pasang-Live-Kerja.bat / Hapus-Live-Kerja.bat (klik dua kali,
    otomatis minta izin Administrator). Panduan lengkap: docs/chrome-kantor.md.

    Berbeda dengan lacak-chrome-edge.reg, skrip ini MENAMBAH alamat Live Kerja ke
    daftar kebijakan tanpa menimpa entri lain yang mungkin sudah diatur IT, dan
    saat dihapus hanya membuang entri milik Live Kerja.

.PARAMETER Url
    Alamat dashboard Live Kerja (origin, tanpa garis miring di akhir).

.PARAMETER Uninstall
    Hapus kebijakan Live Kerja.

.PARAMETER NoPrompt
    Jangan bertanya (mis. untuk dipasang massal lewat skrip lain).

.PARAMETER PolicyRoot
    Akar kebijakan. Bawaan HKLM (berlaku untuk semua user di laptop ini);
    diganti hanya untuk pengujian.
#>
param(
    [string]$Url = 'https://lacaklive.smbservice.xyz',
    [switch]$Uninstall,
    [switch]$NoPrompt,
    [string]$PolicyRoot = 'HKLM:\SOFTWARE\Policies'
)

$ErrorActionPreference = 'Stop'
$Url = $Url.Trim().TrimEnd('/')

$Browsers = @(
    @{ Name = 'Google Chrome';  Key = 'Google\Chrome';  Private = 'IncognitoModeAvailability'; Process = 'chrome' },
    @{ Name = 'Microsoft Edge'; Key = 'Microsoft\Edge'; Private = 'InPrivateModeAvailability'; Process = 'msedge' }
)

# Daftar URL: layar bisa dibagikan ulang tanpa klik, kamera/mikrofon/notifikasi diizinkan otomatis.
$ListPolicies = @(
    'ScreenCaptureWithoutGestureAllowedForOrigins',
    'VideoCaptureAllowedUrls',
    'AudioCaptureAllowedUrls',
    'NotificationsAllowedForUrls'
)

# Mode penyamaran (1 = mati) & DevTools (2 = mati) supaya Live Kerja tidak bisa diakali.
function Get-Flags($Browser) {
    return [ordered]@{ $Browser.Private = 1; 'DeveloperToolsAvailability' = 2 }
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Entri daftar kebijakan = nilai bernama "1", "2", ... berisi URL.
function Get-ListEntries($Path) {
    if (-not (Test-Path $Path)) { return @() }
    $item = Get-ItemProperty -Path $Path
    return @($item.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' })
}

function Add-ListEntry($Path, $Value) {
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    $entries = Get-ListEntries $Path
    if ($entries | Where-Object { $_.Value -eq $Value }) { return 'sudah ada' }
    $next = 1
    while ($entries.Name -contains "$next") { $next++ }
    New-ItemProperty -Path $Path -Name "$next" -Value $Value -PropertyType String -Force | Out-Null
    return "ditambah (#$next)"
}

function Remove-ListEntry($Path, $Value) {
    $mine = Get-ListEntries $Path | Where-Object { $_.Value -eq $Value }
    if (-not $mine) { return 'tidak ada' }
    foreach ($entry in $mine) { Remove-ItemProperty -Path $Path -Name $entry.Name }
    # Daftar yang kini kosong ikut dihapus; daftar berisi entri lain dibiarkan.
    if (-not (Get-ListEntries $Path)) { Remove-Item -Path $Path -Force }
    return 'dihapus'
}

function Set-Flag($Path, $Name, $Value) {
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType DWord -Force | Out-Null
}

# Hanya dihapus kalau nilainya memang yang dipasang Live Kerja (bukan aturan IT lain).
function Remove-Flag($Path, $Name, $Value) {
    if (-not (Test-Path $Path)) { return }
    $current = (Get-ItemProperty -Path $Path).$Name
    if ($null -ne $current -and $current -eq $Value) { Remove-ItemProperty -Path $Path -Name $Name }
}

Write-Host ''
Write-Host '  Live Kerja - kebijakan Chrome & Edge kantor' -ForegroundColor Cyan
Write-Host "  Alamat: $Url"
Write-Host ''

if ($PolicyRoot -like 'HKLM:*' -and -not (Test-Admin)) {
    Write-Host '  Gagal: jalankan sebagai Administrator (klik dua kali file .bat-nya).' -ForegroundColor Red
    exit 1
}

foreach ($browser in $Browsers) {
    $base = Join-Path $PolicyRoot $browser.Key
    Write-Host "  $($browser.Name)" -ForegroundColor White
    foreach ($policy in $ListPolicies) {
        $path = Join-Path $base $policy
        $result = if ($Uninstall) { Remove-ListEntry $path $Url } else { Add-ListEntry $path $Url }
        Write-Host ("    {0,-46} {1}" -f $policy, $result)
    }
    $flags = Get-Flags $browser
    foreach ($name in $flags.Keys) {
        if ($Uninstall) { Remove-Flag $base $name $flags[$name] } else { Set-Flag $base $name $flags[$name] }
        $state = if ($Uninstall) { 'dikembalikan' } else { "= $($flags[$name])" }
        Write-Host ("    {0,-46} {1}" -f $name, $state)
    }
    Write-Host ''
}

if ($Uninstall) {
    Write-Host '  Selesai: kebijakan Live Kerja dihapus.' -ForegroundColor Green
} else {
    Write-Host '  Selesai: kebijakan Live Kerja terpasang.' -ForegroundColor Green
}

# Kebijakan baru dibaca penuh setelah browser dibuka ulang.
$running = @(Get-Process -Name ($Browsers | ForEach-Object { $_.Process }) -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host ''
    Write-Host '  Chrome/Edge sedang terbuka. Kebijakan berlaku setelah browser ditutup lalu dibuka lagi.'
    if (-not $NoPrompt) {
        $answer = Read-Host '  Tutup Chrome & Edge sekarang? Tab yang belum disimpan akan hilang. (y/n)'
        if ($answer -match '^(y|ya)$') {
            $running | Stop-Process -Force -ErrorAction SilentlyContinue
            Write-Host '  Chrome & Edge ditutup. Silakan buka lagi.'
        }
    }
}

if (-not $Uninstall) {
    Write-Host ''
    Write-Host '  Cek: buka chrome://policy (Edge: edge://policy), tekan "Reload policies".'
    Write-Host "  Kebijakan di atas harus tampil dengan nilai $Url dan status OK."
}
exit 0
