$ErrorActionPreference = 'Stop'

# VS Code's Snap exports its private GIO module directory to integrated
# terminals. Host GNOME tools cannot reliably load modules from that directory.
$IsVsCodeSnap =
    (Get-Command snap -ErrorAction SilentlyContinue) -and
    $env:SNAP_NAME -eq 'code' -and
    $env:GIO_MODULE_DIR -like '*/snap/code/*'

if ($IsVsCodeSnap) {
    Remove-Item Env:GIO_MODULE_DIR
}

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

if (-not (Get-Command glib-compile-schemas -ErrorAction SilentlyContinue)) {
    throw 'glib-compile-schemas is required to validate the extension settings.'
}

& glib-compile-schemas --strict --dry-run (Join-Path $SourceDir 'schemas')
if ($LASTEXITCODE -ne 0) {
    throw 'Settings schema validation failed.'
}

& python3 -m unittest discover -s (Join-Path $SourceDir 'tests') -v
if ($LASTEXITCODE -ne 0) {
    throw 'Auto-Powersaver tests failed.'
}

$PythonFiles = @(
    (Join-Path $SourceDir 'auto_powersaver/core.py'),
    (Join-Path $SourceDir 'auto_powersaver/service.py'),
    (Join-Path $SourceDir 'bin/fedorausage')
)
& python3 -m py_compile $PythonFiles
if ($LASTEXITCODE -ne 0) {
    throw 'Auto-Powersaver Python validation failed.'
}

if (Get-Command bash -ErrorAction SilentlyContinue) {
    & bash -n (Join-Path $SourceDir 'scripts/install-auto-powersaver.sh')
    & bash -n (Join-Path $SourceDir 'scripts/uninstall-auto-powersaver.sh')
    & bash -n (Join-Path $SourceDir 'scripts/manual-auto-powersaver-test.sh')
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
