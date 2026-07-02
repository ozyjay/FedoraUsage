# Memory Usage Widget

A small GNOME Shell extension for Fedora Workstation that shows RAM usage in the
top bar and adds a dropdown with RAM and swap details.

This project targets GNOME Shell 50, matching Fedora 44 Workstation on this
machine.

## Install

```bash
pwsh -NoProfile -File ./scripts/install.ps1
```

Then log out and back in, or restart GNOME Shell if your session supports it.
Enable the extension with:

```bash
gnome-extensions enable memory-usage-widget@local
```

## Validate

```bash
pwsh -NoProfile -File ./scripts/test.ps1
```

For live Shell logs while enabling or disabling the extension:

```bash
journalctl --user -f /usr/bin/gnome-shell
```

## Behavior

- Updates every 2 seconds.
- Shows `Mem 42%` in the top bar.
- Uses `/proc/meminfo` and `MemAvailable` for RAM usage.
- Shows warning color at 70% and critical color at 90%.
