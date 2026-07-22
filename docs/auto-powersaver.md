# Auto-Powersaver architecture and operations

Auto-Powersaver is a temperature-driven policy integrated into System Usage
Monitor. It is not a TuneD profile and it does not add another GNOME Power
Mode. GNOME Settings continues to show the active underlying `balanced` or
`powersave` profile through `tuned-ppd`.

## Architecture

The GNOME Shell extension and `fedorausage` CLI are unprivileged D-Bus clients.
They read status and request a fixed set of policy operations from
`fedorausage-auto-powersaver.service`. The root service is the only automatic
controller. It reads the allowlisted `k10temp/Tctl` and `cros_ec/cpu@4c`
`hwmon` sensors, calculates their maximum, runs the policy state machine and
uses `/usr/bin/tuned-adm` without a shell. `amdgpu/edge` is read for diagnostics
only.

The system D-Bus name is
`net.crunchycodes.FedoraUsage.AutoPowersaver1`. Read-only status and bounded
history calls do not authenticate. Each user-requested mutation is checked by
Polkit using
`net.crunchycodes.fedorausage.manage-auto-powersaver`. No background refresh
can open an authentication dialogue.

Policy mode, thermal state, telemetry quality and service health are separate
status fields. A paused or manually overridden policy can therefore remain
thermally hot or telemetry-degraded. Hot protection takes precedence over
pause and manual Balanced requests.

## Policy behaviour

The defaults are an 82°C hot threshold and 72°C recovery threshold, sampled
every five seconds. One valid reading at or above 82°C immediately requests
and verifies `powersave`. There is no entry dwell. Recovery requires the
control temperature to stay at or below 72°C for 30 seconds and three
consecutive valid readings. A hotter reading resets recovery.

Automatic mode selects `balanced` while safely cool. Pause retains the current
profile for 15 minutes or one hour. A manual profile selection lasts 30
minutes. An external TuneD change is classified as a temporary manual override;
the service does not claim to know which application initiated it. Hot safety
may still override that selection with `powersave`.

With one valid control sensor, the default policy permits explicitly degraded
operation and reports it. With neither sensor, the control temperature is
unknown, the current safe profile is retained, and Force Balanced is rejected.
Disabling ordinary automation leaves the current profile unchanged by default.
The menu and CLI provide a separate explicit disable-and-balance action.

## Install or upgrade

The service requires Fedora TuneD, `tuned-ppd`, Python 3 with GObject
introspection, Polkit and systemd. Confirm that `power-profiles-daemon` is not
installed and `tuned.service` is active, then install the privileged component:

```bash
sudo ./scripts/install-auto-powersaver.sh
pwsh -NoProfile -File ./scripts/install.ps1
```

The service installer does not overwrite an existing
`/etc/fedorausage/auto-powersaver.conf`. It creates a timestamped backup and
keeps the existing file. It also detects and disables
`framework-thermal-policy.service`; the new unit conflicts with that legacy
unit so both controllers cannot run together. On a first install, integer
thresholds in `/etc/framework-thermal-policy.conf` are migrated only when both
are present and pass the new safety bounds; the legacy file is backed up.
Arbitrary legacy sensor paths are deliberately not migrated. Review the
migration report and retained configuration before relying on the new policy.

The persistent configuration is root-owned and mode `0600` at:

```text
/etc/fedorausage/auto-powersaver.conf
```

Runtime-only state, history and the duplicate-instance lock are private under:

```text
/run/fedorausage-auto-powersaver/
```

Pause and manual override expiry are never restored from disk after a service
restart or reboot.

## CLI

The CLI uses the same D-Bus contract as the GNOME UI and returns JSON:

```bash
fedorausage auto-powersaver status
fedorausage auto-powersaver enable
fedorausage auto-powersaver disable
fedorausage auto-powersaver disable --balanced
fedorausage auto-powersaver pause 15m
fedorausage auto-powersaver resume
fedorausage auto-powersaver force balanced
fedorausage auto-powersaver force powersave
fedorausage auto-powersaver automatic
fedorausage auto-powersaver set-thresholds 82 72
fedorausage auto-powersaver history --limit 20
```

Only `balanced` and `powersave` are accepted. Thresholds, durations, recovery
settings and history limits are bounded in the privileged service even when a
request does not originate from the supplied UI or CLI.

## Troubleshooting

Inspect status without changing the host:

```bash
fedorausage auto-powersaver status | jq .
systemctl status fedorausage-auto-powersaver.service tuned.service
journalctl -u fedorausage-auto-powersaver.service
/usr/bin/tuned-adm active
```

`service_unavailable` means the D-Bus service could not be reached.
`tuned_unavailable` means the policy service is running but cannot read or
verify TuneD. `telemetry_degraded` means one approved control sensor is usable.
`unknown` means neither is safe to use. Invalid configuration makes service
startup fail visibly rather than weakening hot protection.

## Removal and restoration

By default, removal stops ordinary control and leaves the active TuneD profile
and persistent configuration unchanged:

```bash
sudo ./scripts/uninstall-auto-powersaver.sh
```

Options are explicit:

```bash
sudo ./scripts/uninstall-auto-powersaver.sh --balanced
sudo ./scripts/uninstall-auto-powersaver.sh --remove-config
```

`--balanced` changes the host profile during removal. `--remove-config` removes
the persistent configuration; timestamped upgrade backups remain untouched.
Re-enable a migrated legacy service manually only after the FedoraUsage service
has been removed, otherwise two temperature controllers could compete.

## Manual Framework Desktop validation

Automated tests use a fake TuneD adapter and never change the real host. Run a
manual validation only on the target Framework Desktop, with the system on AC
power and no critical workload. The opt-in test refuses to start without an
explicit acknowledgement and restores its captured initial settings on exit:

```bash
./scripts/manual-auto-powersaver-test.sh \
  --i-understand-this-changes-the-system-power-profile
```

Confirm the reported control temperature is the maximum of `k10temp/Tctl` and
`cros_ec/cpu@4c`, and the reported profile matches `/usr/bin/tuned-adm active`.
Record every command and resulting status in the audit. Temporarily set the hot
threshold at or just below the current control temperature, verify immediate
Power Saver in the CLI, extension and GNOME Settings, then restore 82/72.
Verify the 30-second, three-reading recovery; pause and pause expiry; hot safety
while paused; both manual profiles while cool; Balanced rejection while hot;
Return to Automatic; and an external `/usr/bin/tuned-adm profile` change.

Sensor-loss tests require controlled hardware or a test service instance with
fake `hwmon` data. Do not unbind production kernel drivers merely to simulate a
missing sensor. Confirm one-sensor degraded and no-sensor unknown states in the
fake integration environment. Finish by restoring the initial thresholds,
enabled state and active profile, then append a final status and a written list
of every restoration action to the audit.
