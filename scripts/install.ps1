$ErrorActionPreference = 'Stop'

$Uuid = 'memory-usage-widget@local'
$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TargetDir = Join-Path $HOME ".local/share/gnome-shell/extensions/$Uuid"

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

Copy-Item -Force -Path (Join-Path $SourceDir 'metadata.json') -Destination (Join-Path $TargetDir 'metadata.json')
Copy-Item -Force -Path (Join-Path $SourceDir 'extension.js') -Destination (Join-Path $TargetDir 'extension.js')
Copy-Item -Force -Path (Join-Path $SourceDir 'stylesheet.css') -Destination (Join-Path $TargetDir 'stylesheet.css')

Write-Host "Installed $Uuid to $TargetDir"
Write-Host "Enable it with: gnome-extensions enable $Uuid"
