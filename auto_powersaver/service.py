#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Root-owned system D-Bus service for FedoraUsage Auto-Powersaver."""

from __future__ import annotations

from configparser import ConfigParser
from dataclasses import asdict
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

if Path('/usr/lib/fedorausage').is_dir():
    sys.path.insert(0, '/usr/lib')

import gi

gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

try:
    from auto_powersaver.core import (  # noqa: E402
        ALLOWED_PROFILES,
        CONTROL_SENSORS,
        DIAGNOSTIC_SENSOR,
        Config,
        PolicyController,
        PolicyError,
        SensorReading,
    )
except ModuleNotFoundError:
    from fedorausage.core import (  # type: ignore[no-redef]  # noqa: E402
        ALLOWED_PROFILES,
        CONTROL_SENSORS,
        DIAGNOSTIC_SENSOR,
        Config,
        PolicyController,
        PolicyError,
        SensorReading,
    )


BUS_NAME = 'net.crunchycodes.FedoraUsage.AutoPowersaver1'
OBJECT_PATH = '/net/crunchycodes/FedoraUsage/AutoPowersaver1'
INTERFACE_NAME = BUS_NAME
POLKIT_ACTION = 'net.crunchycodes.fedorausage.manage-auto-powersaver'
CONFIG_PATH = Path('/etc/fedorausage/auto-powersaver.conf')
RUNTIME_DIRECTORY = Path('/run/fedorausage-auto-powersaver')
STATE_PATH = RUNTIME_DIRECTORY / 'state.json'
HISTORY_PATH = RUNTIME_DIRECTORY / 'history.json'
LOCK_PATH = RUNTIME_DIRECTORY / 'policy.lock'
TUNED_ADM = '/usr/bin/tuned-adm'

INTROSPECTION_XML = f'''<node>
  <interface name="{INTERFACE_NAME}">
    <method name="GetStatus"><arg name="status_json" type="s" direction="out"/></method>
    <method name="GetRecentTransitions">
      <arg name="limit" type="u" direction="in"/>
      <arg name="history_json" type="s" direction="out"/>
    </method>
    <method name="Enable"><arg name="status_json" type="s" direction="out"/></method>
    <method name="Disable">
      <arg name="restore_balanced" type="b" direction="in"/>
      <arg name="status_json" type="s" direction="out"/>
    </method>
    <method name="Pause">
      <arg name="duration_seconds" type="u" direction="in"/>
      <arg name="status_json" type="s" direction="out"/>
    </method>
    <method name="Resume"><arg name="status_json" type="s" direction="out"/></method>
    <method name="ForceProfile">
      <arg name="profile" type="s" direction="in"/>
      <arg name="status_json" type="s" direction="out"/>
    </method>
    <method name="ReturnToAutomatic">
      <arg name="status_json" type="s" direction="out"/>
    </method>
    <method name="SetThresholds">
      <arg name="hot_c" type="d" direction="in"/>
      <arg name="recovery_c" type="d" direction="in"/>
      <arg name="status_json" type="s" direction="out"/>
    </method>
    <method name="SetPolicyOptions">
      <arg name="poll_seconds" type="u" direction="in"/>
      <arg name="recovery_dwell_seconds" type="u" direction="in"/>
      <arg name="recovery_reading_count" type="u" direction="in"/>
      <arg name="manual_override_seconds" type="u" direction="in"/>
      <arg name="allow_single_sensor" type="b" direction="in"/>
      <arg name="status_json" type="s" direction="out"/>
    </method>
    <method name="SetDisableBehaviour">
      <arg name="behaviour" type="s" direction="in"/>
      <arg name="status_json" type="s" direction="out"/>
    </method>
    <signal name="StatusChanged"><arg name="status_json" type="s"/></signal>
    <signal name="TransitionRecorded"><arg name="transition_json" type="s"/></signal>
  </interface>
</node>'''


def _atomic_json_write(path: Path, value: object, mode: int) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    with temporary.open('w', encoding='utf-8') as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def load_config(path: Path = CONFIG_PATH) -> Config:
    parser = ConfigParser()
    if path.exists():
        with path.open(encoding='utf-8') as handle:
            parser.read_file(handle)
    values = parser['auto_powersaver'] if parser.has_section('auto_powersaver') else {}
    allowed_keys = {
        'enabled',
        'normal_profile',
        'hot_profile',
        'hot_threshold_c',
        'recovery_threshold_c',
        'poll_interval_seconds',
        'recovery_dwell_seconds',
        'recovery_reading_count',
        'manual_override_seconds',
        'allow_single_sensor_degraded_operation',
        'disable_behavior',
        'hot_protection_when_disabled',
    }
    unexpected_sections = set(parser.sections()) - {'auto_powersaver'}
    unexpected_keys = set(values) - allowed_keys
    if unexpected_sections:
        raise PolicyError(
            f'unrecognised configuration sections: {sorted(unexpected_sections)}')
    if unexpected_keys:
        raise PolicyError(f'unrecognised configuration keys: {sorted(unexpected_keys)}')

    def boolean(name: str, default: bool) -> bool:
        if name not in values:
            return default
        return parser.getboolean('auto_powersaver', name)

    config = Config(
        enabled=boolean('enabled', True),
        normal_profile=values.get('normal_profile', 'balanced'),
        hot_profile=values.get('hot_profile', 'powersave'),
        hot_threshold_c=float(values.get('hot_threshold_c', 82)),
        recovery_threshold_c=float(values.get('recovery_threshold_c', 72)),
        poll_interval_seconds=int(values.get('poll_interval_seconds', 5)),
        recovery_dwell_seconds=int(values.get('recovery_dwell_seconds', 30)),
        recovery_reading_count=int(values.get('recovery_reading_count', 3)),
        manual_override_seconds=int(values.get('manual_override_seconds', 1800)),
        allow_single_sensor_degraded_operation=boolean(
            'allow_single_sensor_degraded_operation', True),
        disable_behavior=values.get('disable_behavior', 'leave_unchanged'),
        hot_protection_when_disabled=boolean('hot_protection_when_disabled', True),
    )
    config.validate()
    return config


def save_config(config: Config, path: Path = CONFIG_PATH) -> None:
    config.validate()
    lines = ['[auto_powersaver]']
    for name, value in asdict(config).items():
        rendered = str(value).lower() if isinstance(value, bool) else str(value)
        lines.append(f'{name} = {rendered}')
    lines.append('')
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    with temporary.open('w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


class HwmonReader:
    """Read only the three fixed, approved hwmon identities."""

    _APPROVED = {
        ('k10temp', 'Tctl'): CONTROL_SENSORS[0],
        ('cros_ec', 'cpu@4c'): CONTROL_SENSORS[1],
        ('amdgpu', 'edge'): DIAGNOSTIC_SENSOR,
    }

    def __init__(self, hwmon_root: Path = Path('/sys/class/hwmon')) -> None:
        self._hwmon_root = hwmon_root

    def read(self) -> dict[str, SensorReading]:
        found: dict[str, SensorReading] = {}
        try:
            directories = tuple(self._hwmon_root.glob('hwmon*'))
        except OSError:
            directories = ()

        for directory in directories:
            try:
                chip = (directory / 'name').read_text(encoding='utf-8').strip()
            except OSError:
                continue
            for input_path in directory.glob('temp*_input'):
                match = re.fullmatch(r'temp(\d+)_input', input_path.name)
                if match is None:
                    continue
                label_path = directory / f'temp{match.group(1)}_label'
                try:
                    label = label_path.read_text(encoding='utf-8').strip()
                except OSError:
                    continue
                identity = self._APPROVED.get((chip, label))
                if identity is None:
                    continue
                try:
                    raw_value = input_path.read_text(encoding='utf-8').strip()
                    temperature_c = int(raw_value) / 1000
                    reading = SensorReading.valid_temperature(
                        temperature_c, diagnostic_only=identity == DIAGNOSTIC_SENSOR)
                except (OSError, ValueError) as error:
                    reading = SensorReading(None, False, error=str(error),
                                            diagnostic_only=identity == DIAGNOSTIC_SENSOR)
                found[identity] = reading

        for identity in (*CONTROL_SENSORS, DIAGNOSTIC_SENSOR):
            found.setdefault(
                identity,
                SensorReading(
                    None, False, error='approved sensor was not found',
                    diagnostic_only=identity == DIAGNOSTIC_SENSOR))
        return found


class TunedAdmAdapter:
    def _run(self, *arguments: str) -> str:
        completed = subprocess.run(
            [TUNED_ADM, *arguments],
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
            shell=False,
        )
        return completed.stdout.strip()

    def active_profile(self) -> str:
        output = self._run('active')
        match = re.search(r'(?:Current active profile|Active profile):\s*(\S+)', output)
        if match is None:
            raise RuntimeError(f'could not parse tuned-adm active output: {output!r}')
        return match.group(1)

    def set_profile(self, profile: str) -> str:
        if profile not in ALLOWED_PROFILES:
            raise PolicyError('only balanced and powersave may be selected')
        self._run('profile', profile)
        resulting_profile = self.active_profile()
        if resulting_profile != profile:
            raise RuntimeError(
                f'TuneD did not activate {profile}; active profile is {resulting_profile}')
        return resulting_profile


class AutoPowersaverService:
    def __init__(self) -> None:
        if os.geteuid() != 0:
            raise PermissionError('the Auto-Powersaver service must run as root')
        RUNTIME_DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(RUNTIME_DIRECTORY, 0o700)
        self._lock_handle = LOCK_PATH.open('w', encoding='utf-8')
        try:
            fcntl.flock(self._lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('another Auto-Powersaver controller is already running') from error
        self._lock_handle.write(f'{os.getpid()}\n')
        self._lock_handle.flush()
        os.chmod(LOCK_PATH, 0o600)

        self._config = load_config()
        self._sensors = HwmonReader()
        self._tuned = TunedAdmAdapter()
        self._controller = PolicyController(self._config, self._tuned, now=time.time)
        if HISTORY_PATH.exists():
            try:
                with HISTORY_PATH.open(encoding='utf-8') as handle:
                    self._controller.restore_history(json.load(handle))
            except (OSError, json.JSONDecodeError) as error:
                print(f'Ignoring unreadable runtime history: {error}', file=sys.stderr)
        self._connection: Gio.DBusConnection | None = None
        self._registration_id = 0
        self._timer_id = 0
        self._last_status_json = ''
        self._last_transition_id: str | None = (
            self._controller.last_transition['transition_id']
            if self._controller.last_transition is not None else None)
        self._last_logged_transition_id = self._last_transition_id
        self._node_info = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION_XML)
        self._loop = GLib.MainLoop()

    def run(self) -> None:
        Gio.bus_own_name(
            Gio.BusType.SYSTEM,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            self._on_bus_acquired,
            None,
            self._on_name_lost,
        )
        self._poll()
        self._loop.run()

    def _on_bus_acquired(self, connection: Gio.DBusConnection, _name: str) -> None:
        self._connection = connection
        self._registration_id = connection.register_object(
            OBJECT_PATH,
            self._node_info.interfaces[0],
            self._handle_method_call,
            None,
            None,
        )
        self._emit_status(force=True)

    def _on_name_lost(self, _connection: Gio.DBusConnection | None, _name: str) -> None:
        self._loop.quit()

    def _schedule_next_poll(self) -> None:
        if self._timer_id:
            GLib.source_remove(self._timer_id)
        self._timer_id = GLib.timeout_add_seconds(
            self._controller.config.poll_interval_seconds, self._poll)

    def _poll(self) -> bool:
        self._timer_id = 0
        self._observe_host()
        self._persist_runtime_state()
        self._emit_status()
        self._schedule_next_poll()
        return GLib.SOURCE_REMOVE

    def _observe_host(self) -> None:
        readings = self._sensors.read()
        try:
            active_profile = self._tuned.active_profile()
            self._controller.observe(readings, active_profile, tuned_available=True)
        except Exception as error:
            self._controller.observe(
                readings, None, tuned_available=False, tuned_error=str(error))

    def _status_json(self) -> str:
        return json.dumps(self._controller.status(), sort_keys=True, separators=(',', ':'))

    def _persist_runtime_state(self) -> None:
        _atomic_json_write(STATE_PATH, self._controller.status(), 0o600)
        _atomic_json_write(HISTORY_PATH, self._controller.history(200), 0o600)

    def _emit_status(self, *, force: bool = False) -> None:
        status_json = self._status_json()
        if self._connection is not None and (force or status_json != self._last_status_json):
            self._connection.emit_signal(
                None, OBJECT_PATH, INTERFACE_NAME, 'StatusChanged',
                GLib.Variant('(s)', (status_json,)))
        self._last_status_json = status_json

        transition = self._controller.last_transition
        transition_id = transition['transition_id'] if transition is not None else None
        if transition is not None and transition_id != self._last_logged_transition_id:
            print(
                f'Auto-Powersaver transition: {json.dumps(transition, sort_keys=True)}',
                flush=True,
            )
            self._last_logged_transition_id = transition_id
        if (
            self._connection is not None and transition is not None and
            transition_id != self._last_transition_id
        ):
            self._connection.emit_signal(
                None, OBJECT_PATH, INTERFACE_NAME, 'TransitionRecorded',
                GLib.Variant('(s)', (json.dumps(transition, sort_keys=True),)))
            self._last_transition_id = transition_id

    def _authorise(self, sender: str) -> None:
        if self._connection is None:
            raise PermissionError('system bus is unavailable')
        subject = ('system-bus-name', {'name': GLib.Variant('s', sender)})
        parameters = GLib.Variant(
            '((sa{sv})sa{ss}us)',
            (subject, POLKIT_ACTION, {}, 1, ''),
        )
        result = self._connection.call_sync(
            'org.freedesktop.PolicyKit1',
            '/org/freedesktop/PolicyKit1/Authority',
            'org.freedesktop.PolicyKit1.Authority',
            'CheckAuthorization',
            parameters,
            GLib.VariantType.new('(bba{ss})'),
            Gio.DBusCallFlags.NONE,
            120_000,
            None,
        )
        authorised, _challenge, _details = result.unpack()
        if not authorised:
            raise PermissionError('not authorised to manage Auto-Powersaver')

    def _handle_method_call(
        self,
        _connection: Gio.DBusConnection,
        sender: str,
        _object_path: str,
        _interface_name: str,
        method_name: str,
        parameters: GLib.Variant,
        invocation: Gio.DBusMethodInvocation,
    ) -> None:
        try:
            if method_name == 'GetStatus':
                invocation.return_value(GLib.Variant('(s)', (self._status_json(),)))
                return
            if method_name == 'GetRecentTransitions':
                limit, = parameters.unpack()
                history = json.dumps(self._controller.history(limit), sort_keys=True)
                invocation.return_value(GLib.Variant('(s)', (history,)))
                return

            self._authorise(sender)
            # Refresh authoritative telemetry before evaluating any mutation,
            # particularly requests that could select Balanced.
            self._observe_host()
            self._persist_runtime_state()
            self._emit_status()
            if method_name == 'Enable':
                self._controller.enable()
            elif method_name == 'Disable':
                restore_balanced, = parameters.unpack()
                self._controller.disable(restore_balanced)
            elif method_name == 'Pause':
                duration_seconds, = parameters.unpack()
                self._controller.pause(duration_seconds)
            elif method_name == 'Resume':
                self._controller.resume()
            elif method_name == 'ReturnToAutomatic':
                self._controller.return_to_automatic()
            elif method_name == 'ForceProfile':
                profile, = parameters.unpack()
                self._controller.force_profile(profile)
            elif method_name == 'SetThresholds':
                hot_c, recovery_c = parameters.unpack()
                self._controller.set_thresholds(hot_c, recovery_c)
                self._observe_host()
            elif method_name == 'SetPolicyOptions':
                poll, dwell, count, override, degraded = parameters.unpack()
                updated = Config(**{
                    **asdict(self._controller.config),
                    'poll_interval_seconds': poll,
                    'recovery_dwell_seconds': dwell,
                    'recovery_reading_count': count,
                    'manual_override_seconds': override,
                    'allow_single_sensor_degraded_operation': degraded,
                })
                self._controller.replace_config(updated)
            elif method_name == 'SetDisableBehaviour':
                behaviour, = parameters.unpack()
                updated = Config(**{
                    **asdict(self._controller.config),
                    'disable_behavior': behaviour,
                })
                self._controller.replace_config(updated)
            else:
                raise PolicyError(f'unknown method: {method_name}')

            self._config = self._controller.config
            save_config(self._config)
            self._persist_runtime_state()
            self._emit_status(force=True)
            self._schedule_next_poll()
            print(
                f'Auto-Powersaver authorised action: sender={sender} method={method_name}',
                flush=True,
            )
            invocation.return_value(GLib.Variant('(s)', (self._status_json(),)))
        except (PolicyError, ValueError) as error:
            invocation.return_dbus_error(
                f'{INTERFACE_NAME}.InvalidRequest', str(error))
        except PermissionError as error:
            invocation.return_dbus_error(
                f'{INTERFACE_NAME}.NotAuthorised', str(error))
        except Exception as error:
            print(f'Auto-Powersaver method {method_name} failed: {error}', file=sys.stderr)
            invocation.return_dbus_error(f'{INTERFACE_NAME}.Failed', str(error))


def main() -> int:
    try:
        AutoPowersaverService().run()
    except Exception as error:
        print(f'Auto-Powersaver failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
