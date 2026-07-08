# FedoraUsage

A small GNOME Shell extension for Fedora Workstation that shows RAM,
temperature, and the Fedora and Work SSD usage in the top bar, and adds a
dropdown with RAM, swap, temperature, and SSD details.

This project targets GNOME Shell 50, matching Fedora 44 Workstation on this
machine.

## Install

```bash
pwsh -NoProfile -File ./scripts/install.ps1
```

Then log out and back in, or restart GNOME Shell if your session supports it.
Enable the extension with:

```bash
gnome-extensions enable FedoraUsage@local
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
- Shows `▦ 42% 🌡 CPU 50°C 🖴 18% 🖴 --%` in the top bar, switching the
  temperature icon to `🔥` when the hottest sensor reaches 75°C.
- Uses a smaller mini-font style for the top-bar percentage numbers.
- Uses `/proc/meminfo` and `MemAvailable` for RAM usage.
- Uses Linux `hwmon` temperature sensors, with `thermal_zone` sensors as a
  fallback. The top bar shows a simplified hottest sensor name and reading, and
  the dropdown names the hottest sensor separately from a collapsible list of
  other detected sensor readings. Raw sensor names such as `k10temp Tctl`,
  `amdgpu edge`, `nvme Composite`, `mt7925_phy0`, `r8169_0_bf00:00`, and
  ChromeOS EC labels are simplified to labels such as `🧠 CPU`, `🎮 GPU`,
  `💾 SSD Composite`, `📶 Wi-Fi`, `🌐 Ethernet`, and `🧱 Mainboard power`.
- Uses GNOME filesystem stats for `/` and the mounted `Work` SSD.
- Looks for the `Work` SSD at common mount points such as
  `/run/media/$USER/Work` and `/mnt/Work`; if it is not mounted, the top bar
  shows `--%`.
- Shows warning colour at 70% and critical colour at 90% for the highest memory
  or SSD usage value, or at 75°C and 90°C for temperature.
