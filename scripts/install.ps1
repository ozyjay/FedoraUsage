$ErrorActionPreference = 'Stop'

$Uuid = 'system-usage@crunchycodes.net'
$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TargetDir = Join-Path $HOME ".local/share/gnome-shell/extensions/$Uuid"

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

Copy-Item -Force -Path (Join-Path $SourceDir 'metadata.json') -Destination (Join-Path $TargetDir 'metadata.json')
Copy-Item -Force -Path (Join-Path $SourceDir 'extension.js') -Destination (Join-Path $TargetDir 'extension.js')
Copy-Item -Force -Path (Join-Path $SourceDir 'stylesheet.css') -Destination (Join-Path $TargetDir 'stylesheet.css')

Write-Host "Installed $Uuid to $TargetDir"

if (Get-Command gnome-extensions -ErrorAction SilentlyContinue) {
    Write-Host "Resetting $Uuid in the GNOME menu bar..."

    & gnome-extensions disable $Uuid 2>$null
    & gnome-extensions enable $Uuid

    if ($LASTEXITCODE -eq 0) {
        Write-Host "Reset $Uuid with: gnome-extensions disable $Uuid; gnome-extensions enable $Uuid"
    } else {
        Write-Host "Installed files, but GNOME did not enable $Uuid in this session."
        Write-Host "Try logging out and back in, then run: gnome-extensions enable $Uuid"
    }
} else {
    Write-Host "Enable it with: gnome-extensions enable $Uuid"
}
