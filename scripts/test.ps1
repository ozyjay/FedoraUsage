$ErrorActionPreference = 'Stop'

$Uuid = 'system-usage@crunchycodes.net'
$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TargetDir = Join-Path $HOME ".local/share/gnome-shell/extensions/$Uuid"
$TempRoot = if ($env:TMPDIR) { $env:TMPDIR } else { '/tmp' }
$PackDir = Join-Path $TempRoot 'system-usage-test'

if (Get-Command jq -ErrorAction SilentlyContinue) {
    & jq empty (Join-Path $SourceDir 'metadata.json') | Out-Null
} else {
    & python3 -m json.tool (Join-Path $SourceDir 'metadata.json') | Out-Null
}

if (Test-Path $PackDir) {
    Remove-Item -Recurse -Force $PackDir
}

New-Item -ItemType Directory -Force -Path $PackDir | Out-Null
& gnome-extensions pack --force --out-dir $PackDir $SourceDir | Out-Null

$InstalledExtensions = & gnome-extensions list 2>$null
if ($LASTEXITCODE -eq 0 -and $InstalledExtensions -contains $Uuid) {
    & gnome-extensions info $Uuid | Out-Null
} elseif (Test-Path $TargetDir) {
    Write-Host "Skipping gnome-extensions info: $Uuid exists on disk but is not registered in this session."
} else {
    Write-Host "Skipping gnome-extensions info: $Uuid is not installed yet."
}

Write-Host 'Validation passed.'
