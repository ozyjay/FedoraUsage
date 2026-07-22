# Contributing

Thank you for helping improve System Usage Monitor. The project targets GNOME
Shell 50 on Fedora 44 Workstation, with Framework Desktop as its primary
hardware target.

## Prerequisites

Development and validation require:

- PowerShell (`pwsh`)
- `gnome-extensions`
- `glib-compile-schemas`
- `jq`, or Python 3 as a metadata-validation fallback
- a GNOME Shell 50 session for runtime testing
- Python 3 with GObject introspection for Auto-Powersaver service validation

## Development workflow

1. Make a focused change in the working tree.
2. If a setting changes, keep the GSettings schema, preferences UI, runtime
   behaviour and README documentation in sync.
3. Run the validation script:

   ```bash
   pwsh -NoProfile -File ./scripts/test.ps1
   ```

4. For runtime changes, install the working tree:

   ```bash
   pwsh -NoProfile -File ./scripts/install.ps1
   ```

5. Exercise the affected behaviour in GNOME Shell and watch for errors:

   ```bash
   journalctl --user -f /usr/bin/gnome-shell
   ```

The installer copies the extension to
`~/.local/share/gnome-shell/extensions/system-usage@crunchycodes.net`, compiles
its settings schema and reloads the extension when the current session permits
it. You may need to log out and back in before GNOME Shell recognises a newly
installed extension.

## Settings changes

Settings are shared through
`org.gnome.shell.extensions.system-usage.gschema.xml`. Existing users retain
stored values across upgrades, so keep key names and value meanings stable.
When introducing a setting:

- choose a safe default;
- constrain values in the schema where practical;
- expose the setting in `prefs.js` when it is user-configurable;
- read and handle it defensively in `extension.js`; and
- describe visible behaviour and data-retention effects in `README.md`.

Use the extension's local schema directory when inspecting settings from a
terminal:

```bash
gsettings \
  --schemadir "$HOME/.local/share/gnome-shell/extensions/system-usage@crunchycodes.net/schemas" \
  list-recursively org.gnome.shell.extensions.system-usage
```

## Hardware compatibility

Linux hardware-monitoring interfaces differ between machines. Changes to
temperature or fan discovery should tolerate absent files, stopped fans and
unrecognised sensor labels. Include the relevant hardware and Fedora/GNOME
versions when reporting or investigating a device-specific issue.

Sensor-history logs are user data. Changes to cleanup behaviour should retain
unreadable or unrecognised content unless it is demonstrably expired and safe
to remove.

## Auto-Powersaver development

The policy engine in `auto_powersaver/core.py` must remain independent of D-Bus,
real sensors and TuneD. Add host-safe unit tests for every policy behaviour.
The validation script runs these tests with a fake TuneD adapter, so it must
never modify the actual host profile.

The privileged adapter may read only the fixed sensor identities and may select
only `balanced` or `powersave`. Never pass input through a shell or broaden the
Polkit action into arbitrary command, sensor-path, profile or unit control.
Keep persistent configuration under `/etc` separate from temporary state under
`/run`.

Installing or manually testing the service changes the host and is not part of
normal validation. Follow the explicit opt-in checklist in
`docs/auto-powersaver.md`, capture an audit, and restore the original enabled
state, thresholds and TuneD profile.

## Release check

The validation script builds a temporary package. To create a release archive
manually, run:

```bash
mkdir -p dist
gnome-extensions pack --force --out-dir dist .
```

Do not commit generated ZIP archives or `gschemas.compiled` files.
