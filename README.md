# System Usage Monitor for Framework Desktop

A GNOME Shell system monitor built for Framework Desktop and compatible with
other computers running Fedora 44 Workstation. It shows configurable RAM,
temperature, active fan speed and filesystem readings in the top bar, with
additional RAM, swap, sensor, fan and storage details in a dropdown menu.
It can also manage a host-level Auto-Powersaver policy through a separately
installed root system service while the extension itself remains unprivileged.

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
- Shows configurable memory, hottest-sensor, active Fan 1, system filesystem
  and secondary SSD readings in the top bar.
- Switches from `🌡` to `🔥` when the hottest sensor reaches 75°C.
- Uses `/proc/meminfo` and `MemAvailable` for RAM usage.
- Reads Linux `hwmon` temperature and fan sensors, falling back to
  `thermal_zone` temperature sensors when needed.
- Simplifies common Framework Desktop sensor names, including CPU, GPU, NVMe,
  Wi-Fi, Ethernet and mainboard readings.
- Hides stopped fans and shows additional active fans in the dropdown menu.
- Records a timestamped sensor snapshot every two seconds in JSON Lines format.
- Keeps sensor history for a configurable number of minutes, hours or days in
  `~/System Usage Logs/`.
- Provides preferences for top-bar readings, the secondary SSD location and
  sensor history.
- Uses GNOME filesystem statistics for the system filesystem mounted at `/`.
- Monitors a secondary SSD at a configurable mount location, defaulting to
  `/mnt/work`.
- Shows warning colour at 70% and critical colour at 90% for memory or storage,
  and at 75°C and 90°C for temperature.
- Integrates Auto-Powersaver mode, control temperature, approved sensor health,
  the active TuneD profile, safe controls and bounded transition history.
- Selects TuneD `powersave` immediately at the hot threshold and returns to
  `balanced` only after validated hysteresis, dwell and consecutive readings.
- Keeps hot protection active during pause and manual override, and respects
  external TuneD changes as temporary manual overrides while safely cool.

## Auto-Powersaver

Auto-Powersaver requires its separately installed root service. The GNOME
extension never runs as root and never invokes TuneD directly. Install the
service, then the extension:

```bash
sudo ./scripts/install-auto-powersaver.sh
pwsh -NoProfile -File ./scripts/install.ps1
```

The service is designed for Framework Desktop with `k10temp/Tctl` and
`cros_ec/cpu@4c` control sensors, Fedora TuneD and `tuned-ppd`. It chooses only
the standard `balanced` and `powersave` profiles. Missing telemetry is never
treated as a cool system. All user-requested system policy changes pass through
a narrow D-Bus API and Polkit authorisation. Policy fields in the extension
preferences are saved together with the **Apply** button. Live service updates
continue to refresh diagnostics without replacing policy edits that have not
yet been applied.

See [Auto-Powersaver architecture and operations](docs/auto-powersaver.md) for
state behaviour, CLI commands, configuration, migration, troubleshooting,
manual hardware validation and safe removal.

## Sensor history

The extension writes one JSON object per line to:

```text
~/System Usage Logs/sensor-data-YYYY-MM-DD.jsonl
```

Each snapshot contains RAM, swap, system filesystem, temperature and fan data.
Temperature readings use `hwmon` when available and fall back to thermal zones,
so the two sources are not duplicated. Stopped fans are included in the log even
though they remain hidden from the panel and menu. Values use explicit units in
their field names, such as `totalKib`, `totalBytes`, `temperatureC` and
`speedRpm`.

The log directory and files are readable only by your user account. A new file
is started each local calendar day. Retention can be set in minutes, hours or
local calendar days, with a default of seven days. Minute and hour retention is
applied to individual records once per minute; day retention keeps complete
calendar-day files. Other files in the directory are not removed. At a
two-second interval, the extension writes 43,200 snapshots per full day. File
sizes depend on the number of sensors; for example, a 2 KiB snapshot is about
84 MiB per day and 591 MiB across seven days.

Sensor history is disabled by default. Open the extension's preferences, turn
on **Record sensor history**, and adjust **Retention length** as needed. Turning
logging off stops new snapshots but retains existing files, and panel monitoring
continues normally. Right-click the top-bar indicator to open preferences.
Reducing retention removes expired matching records during the next snapshot.

```bash
gnome-extensions prefs system-usage@crunchycodes.net
```

The same preferences window controls which readings appear in the top bar.
Disabling a top-bar reading does not remove its details from the dropdown or
sensor history. Set **Secondary SSD location** to the absolute path at which
that filesystem is mounted.

Read today's latest records with:

```bash
tail -n 20 "$HOME/System Usage Logs/sensor-data-$(date +%F).jsonl"
```

For formatted live output with `jq`:

```bash
tail -f "$HOME/System Usage Logs/sensor-data-$(date +%F).jsonl" | jq .
```

Each record has this top-level structure:

```json
{
  "timestamp": "2026-07-21T10:15:30.000000+10",
  "schemaVersion": 1,
  "memory": {},
  "swap": {},
  "filesystems": [],
  "temperatures": [],
  "fans": []
}
```

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete development workflow,
settings-change checklist and hardware compatibility guidance.

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
