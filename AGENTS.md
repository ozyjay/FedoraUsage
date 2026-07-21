# Repository Instructions

These instructions apply to the entire repository and supplement the user's
personal Codex instructions.

## Project overview

System Usage Monitor is a GNOME Shell 50 extension written in GJS for Fedora 44
Workstation. Framework Desktop is the primary hardware target. The public
extension UUID is `system-usage@crunchycodes.net`.

## Repository layout

- `extension.js` contains the panel indicator, system metric collection and
  sensor-history logger.
- `prefs.js` defines the Libadwaita preferences window.
- `schemas/` contains the GSettings schema used by both runtime and preferences
  code.
- `stylesheet.css` contains extension-specific GNOME Shell styles.
- `metadata.json` contains GNOME Shell extension metadata and compatibility.
- `scripts/install.ps1` installs the working tree into the user's local GNOME
  Shell extension directory.
- `scripts/test.ps1` validates metadata, the schema and release packaging.

## Implementation guidance

- Follow the existing GJS and GNOME Shell patterns; do not introduce Node.js or
  browser-only APIs.
- Keep metric collection resilient to missing Linux sensor files. Hardware
  sensors vary between machines, and unavailable optional readings must not
  prevent the indicator from updating.
- Preserve explicit units in names used for stored sensor data, such as
  `totalKib`, `totalBytes`, `temperatureC` and `speedRpm`.
- Treat sensor-history files as user data. Prefer retaining malformed or
  unrecognised records over deleting them.
- Keep files and log directories private to the current user.
- When adding or changing a preference, update the schema, `prefs.js`, runtime
  handling in `extension.js`, and relevant README documentation together.
- Maintain compatibility for existing GSettings keys and values unless a
  deliberate migration is included.
- Keep user-facing text and documentation in Australian English.

## Verification

Run the repository validation after code, schema, metadata or packaging changes:

```bash
pwsh -NoProfile -File ./scripts/test.ps1
```

For runtime changes, install the working tree and inspect GNOME Shell logs:

```bash
pwsh -NoProfile -File ./scripts/install.ps1
journalctl --user -f /usr/bin/gnome-shell
```

Installing changes affects the current user's GNOME Shell extension directory,
so do it only when runtime verification is warranted. Report when a live GNOME
session or representative hardware was unavailable for testing.

## Change scope

- Keep changes focused and preserve unrelated work.
- Update `README.md` for user-visible behaviour and `CONTRIBUTING.md` for
  development workflow changes.
- Do not commit generated release archives or compiled GSettings schema files.
- Do not change the UUID, supported GNOME Shell version or release version as a
  side effect of unrelated work.
