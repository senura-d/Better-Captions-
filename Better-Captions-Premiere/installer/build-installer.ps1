# Builds BetterCaptionsSetup.exe: the CEP extension packed into a small
# Windows installer. Uses only what ships with Windows (.NET Framework 4.8's
# C# compiler and System.Drawing), plus npm for the extension build.
#
#   powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1
#   (or: npm run installer)

param(
    [string]$OutFile = (Join-Path $PSScriptRoot 'bin\BetterCaptionsSetup.exe'),
    [switch]$SkipExtensionBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$obj = Join-Path $PSScriptRoot 'obj'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found at $csc (.NET Framework 4.8 is required)." }

New-Item -ItemType Directory -Force -Path $obj, (Split-Path $OutFile -Parent) | Out-Null

# 1. Build the extension.
if (-not $SkipExtensionBuild) {
    Push-Location $root
    try {
        npm run cep
        if ($LASTEXITCODE -ne 0) { throw 'npm run cep failed.' }
    } finally { Pop-Location }
}
$extension = Join-Path $root 'cep-dist\com.bettercaptions.cep'
if (-not (Test-Path (Join-Path $extension 'CSXS\manifest.xml'))) { throw "Extension build not found: $extension" }

# 2. Pack it as the installer's embedded payload (entries use forward slashes).
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zipPath = Join-Path $obj 'Extension.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$zip = [IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    $base = (Resolve-Path $extension).Path.TrimEnd('\') + '\'
    Get-ChildItem -LiteralPath $extension -Recurse -File | ForEach-Object {
        $name = $_.FullName.Substring($base.Length).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name, 'Optimal')
    }
} finally { $zip.Dispose() }

# 3. Draw the app icon (256 px, stored as PNG inside the .ico).
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object Drawing.Bitmap $size, $size
$g = [Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([Drawing.Color]::Transparent)
$r = 52
$path = New-Object Drawing.Drawing2D.GraphicsPath
$path.AddArc(8, 8, $r, $r, 180, 90)
$path.AddArc($size - 8 - $r, 8, $r, $r, 270, 90)
$path.AddArc($size - 8 - $r, $size - 8 - $r, $r, $r, 0, 90)
$path.AddArc(8, $size - 8 - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(124, 92, 255))), $path)
$white = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
$g.FillRectangle($white, 56, 112, 144, 26)
$g.FillRectangle($white, 84, 160, 88, 26)
$g.Dispose()
$png = New-Object IO.MemoryStream
$bmp.Save($png, [Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$pngBytes = $png.ToArray()
$icoPath = Join-Path $obj 'icon.ico'
$ico = New-Object IO.BinaryWriter ([IO.File]::Create($icoPath))
try {
    $ico.Write([UInt16]0); $ico.Write([UInt16]1); $ico.Write([UInt16]1)          # ICONDIR: 1 image
    $ico.Write([byte]0); $ico.Write([byte]0); $ico.Write([byte]0); $ico.Write([byte]0)  # 256x256, no palette
    $ico.Write([UInt16]1); $ico.Write([UInt16]32)                                  # planes, bit depth
    $ico.Write([UInt32]$pngBytes.Length); $ico.Write([UInt32]22)                   # size, offset
    $ico.Write($pngBytes)
} finally { $ico.Dispose() }

# 4. Compile.
$refs = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
    'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll') | ForEach-Object { "/reference:$_" }
& $csc /nologo /target:winexe /optimize+ "/out:$OutFile" "/win32icon:$icoPath" `
    "/resource:$zipPath,Extension.zip" @refs (Join-Path $PSScriptRoot 'Installer.cs')
if ($LASTEXITCODE -ne 0) { throw 'Compiling the installer failed.' }

$kb = [Math]::Round((Get-Item $OutFile).Length / 1KB)
Write-Host "Built $OutFile ($kb KB)" -ForegroundColor Green
