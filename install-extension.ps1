# Installs (or removes) Better Captions as a CEP extension: a third-party
# panel under Window > Extensions, with no UXP and no Creative Cloud.
#
#   1. copies the extension folder into %APPDATA%\Adobe\CEP\extensions
#   2. makes sure Premiere allows unsigned extensions (PlayerDebugMode = 1)
#
# Usage (or double-click "Install Extension.bat"):
#   powershell -ExecutionPolicy Bypass -File install-extension.ps1
#   powershell -ExecutionPolicy Bypass -File install-extension.ps1 -Uninstall

param(
    [switch]$Uninstall,
    [string]$Source = (Join-Path $PSScriptRoot 'BetterCaptions-Extension\com.bettercaptions.cep'),
    [string]$ExtensionsDir = (Join-Path $env:APPDATA 'Adobe\CEP\extensions'),
    [switch]$NoPause,
    [switch]$SkipPremiereCheck,
    [switch]$SkipDebugMode
)

$ErrorActionPreference = 'Stop'
$bundleId = 'com.bettercaptions.cep'

function Pause-Exit([int]$code) {
    if (-not $NoPause) {
        Write-Host ''
        Read-Host 'Press Enter to close'
    }
    exit $code
}

try {
    if (-not $SkipPremiereCheck -and (Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue)) {
        Write-Host 'Premiere Pro is running. Close it first, then run this again.' -ForegroundColor Yellow
        Pause-Exit 1
    }

    $target = Join-Path $ExtensionsDir $bundleId
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }

    if ($Uninstall) {
        Write-Host 'Better Captions extension was removed.' -ForegroundColor Green
        Pause-Exit 0
    }

    if (-not (Test-Path -LiteralPath (Join-Path $Source 'CSXS\manifest.xml'))) {
        throw "Extension folder not found: $Source"
    }
    New-Item -ItemType Directory -Force -Path $ExtensionsDir | Out-Null
    Copy-Item -LiteralPath $Source -Destination $target -Recurse -Force

    # Premiere only loads unsigned extensions when PlayerDebugMode is "1" for its
    # CEP version (CSXS.12 for Premiere 2025-2026; earlier/later versions included).
    $changed = @()
    if (-not $SkipDebugMode) {
        foreach ($v in 9..16) {
            $key = "HKCU:\Software\Adobe\CSXS.$v"
            $current = (Get-ItemProperty -Path $key -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
            if ("$current" -ne '1') {
                New-Item -Path $key -Force | Out-Null
                New-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
                $changed += "CSXS.$v"
            }
        }
    }

    Write-Host 'Better Captions extension installed to:' -ForegroundColor Green
    Write-Host "  $target"
    if ($changed.Count) {
        Write-Host "Turned on unsigned-extension loading for: $($changed -join ', ')"
    } else {
        Write-Host 'Unsigned-extension loading was already on.'
    }
    Write-Host ''
    Write-Host 'Open Premiere Pro, then go to Window > Extensions > Better Captions.'
    Pause-Exit 0
} catch {
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
    Pause-Exit 1
}
