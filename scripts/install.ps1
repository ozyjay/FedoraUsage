$ErrorActionPreference = 'Stop'

$Uuid = 'system-usage@crunchycodes.net'
$LegacyUuid = 'FedoraUsage@local'
$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TargetDir = Join-Path $HOME ".local/share/gnome-shell/extensions/$Uuid"
$SchemaName = 'org.gnome.shell.extensions.system-usage.gschema.xml'
$SourceSchema = Join-Path $SourceDir "schemas/$SchemaName"
$TargetSchemaDir = Join-Path $TargetDir 'schemas'

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
New-Item -ItemType Directory -Force -Path $TargetSchemaDir | Out-Null

Copy-Item -Force -Path (Join-Path $SourceDir 'metadata.json') -Destination (Join-Path $TargetDir 'metadata.json')
Copy-Item -Force -Path (Join-Path $SourceDir 'extension.js') -Destination (Join-Path $TargetDir 'extension.js')
Copy-Item -Force -Path (Join-Path $SourceDir 'prefs.js') -Destination (Join-Path $TargetDir 'prefs.js')
Copy-Item -Force -Path (Join-Path $SourceDir 'stylesheet.css') -Destination (Join-Path $TargetDir 'stylesheet.css')
Copy-Item -Force -Path $SourceSchema -Destination (Join-Path $TargetSchemaDir $SchemaName)

if (-not (Get-Command glib-compile-schemas -ErrorAction SilentlyContinue)) {
    throw 'glib-compile-schemas is required to install the extension settings.'
}

& glib-compile-schemas $TargetSchemaDir
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to compile the extension settings schema.'
}

Write-Host "Installed $Uuid to $TargetDir"

if (Get-Command gnome-extensions -ErrorAction SilentlyContinue) {
    $InstalledExtensions = & gnome-extensions list 2>$null
    if ($LASTEXITCODE -eq 0 -and $InstalledExtensions -contains $LegacyUuid) {
        & gnome-extensions disable $LegacyUuid 2>$null
        Write-Host "Disabled obsolete extension $LegacyUuid"
    }

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
