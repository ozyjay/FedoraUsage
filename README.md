# System Usage Monitor for Framework Desktop

A GNOME Shell system monitor built for Framework Desktop and compatible with
other computers running Fedora 44 Workstation. It shows RAM, temperature,
active fan speed and system
filesystem usage in the top bar, with additional RAM, swap, sensor, fan and
storage details in a dropdown menu.

The extension targets GNOME Shell 50 and is currently tested on Fedora 44
Workstation. It uses standard Linux interfaces, so its core memory and
filesystem monitoring should work across Fedora 44 Workstation hardware.
Temperature and fan availability depends on the sensors exposed by each
machine. It may also work on other GNOME-based Linux systems, but Framework
Desktop on Fedora Workstation is the primary target.

This is an independent community project. It is not affiliated with or endorsed
by Framework Computer Inc. Framework and Framework Desktop are trademarks of
Framework Computer Inc.

## Features

- Updates every two seconds.
- Shows memory use, the hottest detected sensor, active Fan 1 speed and system
  filesystem use in the top bar.
- Switches from `🌡` to `🔥` when the hottest sensor reaches 75°C.
- Uses `/proc/meminfo` and `MemAvailable` for RAM usage.
- Reads Linux `hwmon` temperature and fan sensors, falling back to
  `thermal_zone` temperature sensors when needed.
- Simplifies common Framework Desktop sensor names, including CPU, GPU, NVMe,
  Wi-Fi, Ethernet and mainboard readings.
- Hides stopped fans and shows additional active fans in the dropdown menu.
- Uses GNOME filesystem statistics for the system filesystem mounted at `/`.
- Shows warning colour at 70% and critical colour at 90% for memory or storage,
  and at 75°C and 90°C for temperature.

## Install for development

```bash
pwsh -NoProfile -File ./scripts/install.ps1
```

Then log out and back in, or restart GNOME Shell if the session supports it.
Enable the extension with:

```bash
gnome-extensions enable system-usage@crunchycodes.net
```

If the earlier local development version is installed, disable it to avoid two
indicators appearing:

```bash
gnome-extensions disable FedoraUsage@local
```

## Validate

```bash
pwsh -NoProfile -File ./scripts/test.ps1
```

For live GNOME Shell logs while enabling or disabling the extension:

```bash
journalctl --user -f /usr/bin/gnome-shell
```

## Build a release archive

```bash
mkdir -p dist
gnome-extensions pack --force --out-dir dist .
```

The generated ZIP can be submitted to
[GNOME Shell Extensions](https://extensions.gnome.org/). The public extension
UUID is `system-usage@crunchycodes.net`; `crunchycodes.net` is a namespace
controlled by the project owner.

## Licence

System Usage Monitor is distributed under the GNU General Public License,
version 3 or later. See [LICENSE](LICENSE).
