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

`enabled` remains in D-Bus and CLI status for compatibility and means only
that ordinary automatic profile management is enabled. New clients should use
the clearer `automatic_management_enabled`,
`hot_protection_when_disabled` and `service_running` fields.

## Automatic management versus hot protection

| Automatic management | Hot protection while off | Result |
| --- | ---: | --- |
| On | On | Balanced while cool; Power Saver when hot |
| Off | On | Current/manual profile retained while cool; Power Saver forced when hot |
| Off | Off | FedoraUsage does not automatically change profiles |
| On | Off | Protection-while-off setting is inactive while automatic management is on |

Turning off **Automatically manage power profile** disables ordinary
Balanced-while-cool and Power-Saver-while-hot management. It leaves the current
profile unchanged unless the explicit safe Balanced option is used. By
default, hot protection remains active and may still select `powersave` at the
hot threshold. Turning that additional safeguard off requires a separate
warning and authorised request; it does not affect independent hardware or
firmware protections and it does not stop the service.

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
When ordinary automation is disabled, recovery clears the thermal latch after
validated dwell/readings but does not automatically select Balanced.

Effective profile reasons are stable machine-readable codes, including
`automatic_normal`, `automatic_hot`, `hot_protection_while_disabled`,
`manual_override`, `external_profile_change`, `forced_power_saver`,
`forced_balanced`, `recovery`, `profile_unchanged`, `tuned_unavailable` and
`telemetry_unknown`. Transition records use the actual policy control
temperature, including notifications such as “Hot protection selected Power
Saver at 90.2°C.”

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
keeps the existing file. It reports and refuses to continue when
`framework-thermal-policy.service` is active or enabled; review and explicitly
disable that legacy controller before re-running the installer. FedoraUsage
does not change a detected controller. The new unit conflicts with that legacy
unit so both controllers cannot run together. On a first install, integer
thresholds in `/etc/framework-thermal-policy.conf` are migrated only when both
are present and pass the new safety bounds; the legacy file is backed up.
Arbitrary legacy sensor paths are deliberately not migrated. Review the
migration report and retained configuration before relying on the new policy.

An existing explicit `hot_protection_when_disabled` value is retained. If that
field is absent, the service safely reads it as `true`; the next authorised
configuration save persists it along with every existing policy value. The
installer creates a timestamped backup before retaining an existing file.

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
fedorausage auto-powersaver protection status
fedorausage auto-powersaver protection enable
fedorausage auto-powersaver protection disable
fedorausage auto-powersaver disable-policy
fedorausage auto-powersaver pause 15m
fedorausage auto-powersaver resume
fedorausage auto-powersaver force balanced
fedorausage auto-powersaver force powersave
fedorausage auto-powersaver automatic
fedorausage auto-powersaver set-thresholds 82 72
fedorausage auto-powersaver history --limit 20
fedorausage auto-powersaver conflicts
```

`disable` means disable ordinary automatic management; hot protection remains
active unless separately disabled. `disable-policy` deliberately disables both
policy behaviours but keeps the root service running. Neither command stops
`tuned.service` or the FedoraUsage service. `--balanced` is rejected while hot,
or when telemetry is unknown or stale.

Only `balanced` and `powersave` are accepted. Thresholds, durations, recovery
settings and history limits are bounded in the privileged service even when a
request does not originate from the supplied UI or CLI.

## External changes and competing-controller diagnostics

The service observes TuneD profile changes that do not match a pending
FedoraUsage request. It records them as `external_profile_change`, counts them,
and may treat them as a temporary manual override while ordinary management is
enabled. It does not claim GNOME Settings or any candidate caused a change
without direct evidence. History can instead say that an external change
occurred while a high-confidence candidate was active.

At startup, on manual rescan, hourly at most, and after every third unexplained
external change, the service performs bounded read-only checks. It inspects a
fixed set of systemd, `/usr/local`, cron and desktop-autostart locations plus
only the systemd/autostart subdirectories of bounded `/home` entries. It looks
for explicit `tuned-adm profile`, `powerprofilesctl set`, `cpupower
frequency-set`, governor, EPP and AMD P-State evidence, as well as the known
legacy controller, TLP and `power-profiles-daemon`. Unit identifiers, file
sizes, command output, files per directory and result counts are bounded.

Findings report scope, active/enabled state, confidence, risk, evidence and
safe inspection commands. FedoraUsage components, `tuned.service`, `tuned-ppd`
and ordinary GNOME profile UI are excluded. No finding is stopped, disabled,
edited, masked, removed or otherwise changed. A partial or failed scan is
reported and cannot affect thermal protection.

## Troubleshooting

Inspect status without changing the host:

```bash
fedorausage auto-powersaver status | jq .
systemctl status fedorausage-auto-powersaver.service tuned.service
journalctl -u fedorausage-auto-powersaver.service
/usr/bin/tuned-adm active
fedorausage auto-powersaver conflicts | jq .
```

`service_unavailable` means the D-Bus service could not be reached.
`tuned_unavailable` means the policy service is running but cannot read or
verify TuneD. `telemetry_degraded` means one approved control sensor is usable.
`unknown` means neither is safe to use. Invalid configuration makes service
startup fail visibly rather than weakening hot protection.

Potential conflicts are diagnostic, not proof of causation. Inspect a reported
unit with only the `safe_inspection_commands` returned for that finding. To
stop FedoraUsage itself entirely, as a separate administrative operation, run:

```bash
sudo systemctl disable --now fedorausage-auto-powersaver.service
```

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

The manual script also captures automatic management and hot protection
separately, exercises disabled-but-protecting behaviour, restores the original
protection value and records a conflict scan. It never creates a real competing
controller; use a fake integration environment for that case.
