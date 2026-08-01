# SPDX-License-Identifier: GPL-3.0-or-later

from dataclasses import replace
import tempfile
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ElementTree

from auto_powersaver.core import Config, PolicyController, PolicyError, SensorReading
from auto_powersaver.conflicts import ConflictScanner, HostConflictAdapter, MAX_FINDINGS


class Clock:
    def __init__(self) -> None:
        self.value = 1_700_000_000.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class FakeTuned:
    def __init__(self, profile: str = 'balanced') -> None:
        self.profile = profile
        self.requests: list[str] = []

    def set_profile(self, profile: str) -> str:
        self.requests.append(profile)
        self.profile = profile
        return profile


class FailingTuned(FakeTuned):
    def set_profile(self, profile: str) -> str:
        self.requests.append(profile)
        raise RuntimeError('simulated TuneD failure')


def readings(tctl: float | None, ec: float | None) -> dict[str, SensorReading]:
    def reading(value: float | None) -> SensorReading:
        return (
            SensorReading.valid_temperature(value)
            if value is not None else SensorReading(None, False, error='missing'))

    return {
        'k10temp/Tctl': reading(tctl),
        'cros_ec/cpu@4c': reading(ec),
        'amdgpu/edge': SensorReading.valid_temperature(45, diagnostic_only=True),
    }


class PolicyControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.tuned = FakeTuned()
        self.config = Config(recovery_dwell_seconds=10, recovery_reading_count=3)
        self.controller = PolicyController(self.config, self.tuned, now=self.clock)

    def observe(self, tctl: float | None, ec: float | None) -> None:
        self.controller.observe(readings(tctl, ec), self.tuned.profile)

    def test_control_temperature_uses_maximum_control_sensor(self) -> None:
        self.observe(64, 67)
        self.assertEqual(self.controller.control_temperature_c, 67)
        self.assertEqual(self.controller.thermal_state, 'normal')

    def test_gpu_is_diagnostic_only(self) -> None:
        values = readings(64, 67)
        values['amdgpu/edge'] = SensorReading.valid_temperature(100, diagnostic_only=True)
        self.controller.observe(values, self.tuned.profile)
        self.assertEqual(self.controller.control_temperature_c, 67)
        self.assertFalse(self.controller.hot_latched)

    def test_hot_transition_is_immediate(self) -> None:
        self.observe(82, 70)
        self.assertEqual(self.tuned.requests, ['powersave'])
        self.assertTrue(self.controller.hot_latched)
        self.assertEqual(self.controller.active_profile, 'powersave')

    def test_recovery_requires_dwell_and_consecutive_readings(self) -> None:
        self.observe(83, 70)
        self.clock.advance(1)
        self.observe(70, 71)
        self.clock.advance(5)
        self.observe(70, 71)
        self.assertEqual(self.tuned.profile, 'powersave')
        self.clock.advance(5)
        self.observe(70, 71)
        self.assertEqual(self.tuned.profile, 'balanced')
        self.assertFalse(self.controller.hot_latched)

    def test_new_hot_reading_resets_recovery(self) -> None:
        self.observe(83, 70)
        self.clock.advance(1)
        self.observe(70, 71)
        self.clock.advance(10)
        self.observe(83, 70)
        self.clock.advance(1)
        self.observe(70, 71)
        self.clock.advance(5)
        self.observe(70, 71)
        self.assertEqual(self.tuned.profile, 'powersave')

    def test_failed_transition_is_rate_limited_and_retried_after_timeout(self) -> None:
        tuned = FailingTuned()
        controller = PolicyController(self.config, tuned, now=self.clock)
        controller.observe(readings(83, 80), tuned.profile)
        self.assertEqual(controller.service_health, 'fault')
        self.clock.advance(5)
        controller.observe(readings(83, 80), tuned.profile)
        self.assertEqual(tuned.requests, ['powersave'])
        self.clock.advance(11)
        controller.observe(readings(83, 80), tuned.profile)
        self.assertEqual(tuned.requests, ['powersave', 'powersave'])

    def test_one_sensor_degraded_operation(self) -> None:
        self.observe(None, 83)
        self.assertEqual(self.controller.telemetry_quality, 'degraded')
        self.assertEqual(self.tuned.profile, 'powersave')

    def test_both_sensors_missing_never_selects_balanced(self) -> None:
        self.observe(83, 83)
        self.tuned.requests.clear()
        self.observe(None, None)
        self.assertEqual(self.controller.thermal_state, 'hot')
        self.assertEqual(self.controller.service_health, 'fault')
        self.assertEqual(self.tuned.requests, [])
        with self.assertRaises(PolicyError):
            self.controller.force_profile('balanced')

    def test_pause_does_not_disable_hot_protection(self) -> None:
        self.observe(60, 61)
        self.controller.pause(900)
        self.observe(83, 80)
        self.assertEqual(self.controller.policy_mode, 'paused')
        self.assertEqual(self.tuned.profile, 'powersave')

    def test_manual_balanced_does_not_disable_hot_protection(self) -> None:
        self.observe(60, 61)
        self.controller.force_profile('balanced')
        self.observe(83, 80)
        self.assertEqual(self.controller.policy_mode, 'manual_override')
        self.assertEqual(self.tuned.profile, 'powersave')

    def test_force_balanced_is_rejected_while_hot(self) -> None:
        self.observe(83, 80)
        with self.assertRaises(PolicyError):
            self.controller.force_profile('balanced')

    def test_force_balanced_is_rejected_with_stale_telemetry(self) -> None:
        self.observe(60, 61)
        self.clock.advance(self.config.poll_interval_seconds * 2 + 1)
        with self.assertRaises(PolicyError):
            self.controller.force_profile('balanced')
        self.assertGreater(
            self.controller.status()['sensor_readings']['k10temp/Tctl']['age_seconds'],
            self.config.poll_interval_seconds * 2)

    def test_enabling_while_hot_applies_safety_immediately(self) -> None:
        controller = PolicyController(
            replace(self.config, enabled=False, hot_protection_when_disabled=False),
            self.tuned,
            now=self.clock,
        )
        controller.observe(readings(83, 80), self.tuned.profile)
        self.assertEqual(self.tuned.profile, 'balanced')
        controller.enable()
        self.assertEqual(self.tuned.profile, 'powersave')

    def test_pause_and_manual_override_expire(self) -> None:
        self.observe(60, 61)
        self.controller.pause(60)
        self.clock.advance(60)
        self.observe(60, 61)
        self.assertEqual(self.controller.policy_mode, 'automatic')
        self.controller.force_profile('powersave')
        self.clock.advance(self.config.manual_override_seconds)
        self.observe(60, 61)
        self.assertEqual(self.controller.policy_mode, 'automatic')
        self.assertEqual(self.tuned.profile, 'balanced')

    def test_pause_resumes_unexpired_manual_override(self) -> None:
        self.observe(60, 61)
        self.controller.force_profile('powersave')
        self.controller.pause(60)
        self.clock.advance(60)
        self.observe(60, 61)
        self.assertEqual(self.controller.policy_mode, 'manual_override')
        self.assertEqual(self.controller.manual_override_profile, 'powersave')

    def test_external_profile_change_becomes_manual_override(self) -> None:
        self.observe(60, 61)
        self.controller.active_competing_controllers = [
            'system:systemd_unit:custom-power-policy.service']
        self.tuned.profile = 'powersave'
        self.observe(60, 61)
        self.assertEqual(self.controller.policy_mode, 'manual_override')
        self.assertEqual(self.controller.manual_override_profile, 'powersave')
        self.assertEqual(
            self.controller.last_transition['reason'], 'external_profile_change')
        status = self.controller.status()
        self.assertTrue(status['external_profile_change_observed'])
        self.assertEqual(status['external_change_count'], 1)
        self.assertEqual(status['effective_profile_reason'], 'external_profile_change')
        self.assertEqual(
            self.controller.last_transition['correlated_active_controllers'],
            ['system:systemd_unit:custom-power-policy.service'])

    def test_disable_leaves_profile_unchanged(self) -> None:
        self.observe(60, 61)
        self.controller.disable()
        self.assertEqual(self.tuned.requests, [])

    def test_disabled_mode_keeps_hot_protection_by_default(self) -> None:
        self.observe(60, 61)
        self.controller.disable()
        self.observe(83, 80)
        self.assertEqual(self.controller.policy_mode, 'disabled')
        self.assertEqual(self.tuned.profile, 'powersave')
        status = self.controller.status()
        self.assertFalse(status['automatic_management_enabled'])
        self.assertEqual(status['enabled'], status['automatic_management_enabled'])
        self.assertTrue(status['hot_protection_when_disabled'])
        self.assertTrue(status['service_running'])
        self.assertEqual(
            status['effective_profile_reason'],
            'hot_protection_while_disabled')

    def test_disabled_mode_does_not_change_profile_when_protection_is_off(self) -> None:
        controller = PolicyController(
            replace(self.config, enabled=False, hot_protection_when_disabled=False),
            self.tuned,
            now=self.clock,
        )
        controller.observe(readings(83, 80), self.tuned.profile)
        self.assertEqual(self.tuned.requests, [])
        self.assertEqual(controller.active_profile, 'balanced')
        self.assertEqual(controller.status()['effective_profile_reason'], 'profile_unchanged')

    def test_hot_protection_can_be_changed_independently(self) -> None:
        self.observe(60, 61)
        self.controller.disable()
        self.controller.set_hot_protection_when_disabled(False)
        self.observe(83, 80)
        self.assertEqual(self.tuned.requests, [])
        self.assertFalse(self.controller.status()['hot_protection_when_disabled'])

    def test_operating_modes_map_to_three_distinct_behaviours(self) -> None:
        self.observe(60, 61)
        self.assertEqual(self.controller.status()['operating_mode'], 'automatic')

        self.controller.set_operating_mode('protection_only')
        status = self.controller.status()
        self.assertEqual(status['operating_mode'], 'protection_only')
        self.assertFalse(status['automatic_management_enabled'])
        self.assertTrue(status['hot_protection_when_disabled'])
        self.observe(83, 80)
        self.assertEqual(self.tuned.profile, 'powersave')

        request_count = len(self.tuned.requests)
        self.controller.set_operating_mode('off')
        status = self.controller.status()
        self.assertEqual(status['operating_mode'], 'off')
        self.assertFalse(status['automatic_management_enabled'])
        self.assertFalse(status['hot_protection_when_disabled'])
        self.observe(84, 81)
        self.assertEqual(len(self.tuned.requests), request_count)

    def test_automatic_mode_canonicalises_legacy_protection_setting(self) -> None:
        controller = PolicyController(
            replace(self.config, hot_protection_when_disabled=False),
            self.tuned,
            now=self.clock,
        )
        controller.observe(readings(60, 61), self.tuned.profile)
        controller.set_operating_mode('automatic')
        self.assertTrue(controller.status()['hot_protection_when_disabled'])
        with self.assertRaises(PolicyError):
            controller.set_operating_mode('unsupported')

    def test_enabling_protection_while_disabled_and_hot_is_immediate(self) -> None:
        controller = PolicyController(
            replace(self.config, enabled=False, hot_protection_when_disabled=False),
            self.tuned,
            now=self.clock,
        )
        controller.observe(readings(83, 80), self.tuned.profile)
        controller.set_hot_protection_when_disabled(True)
        self.assertEqual(self.tuned.profile, 'powersave')
        self.assertEqual(
            controller.status()['effective_profile_reason'],
            'hot_protection_while_disabled')

    def test_degraded_operation_can_be_disabled(self) -> None:
        controller = PolicyController(
            replace(self.config, allow_single_sensor_degraded_operation=False),
            self.tuned,
            now=self.clock,
        )
        controller.observe(readings(None, 83), self.tuned.profile)
        self.assertEqual(controller.telemetry_quality, 'unknown')
        self.assertEqual(controller.control_temperature_c, None)
        self.assertEqual(self.tuned.profile, 'balanced')

    def test_disable_and_balance_is_explicit(self) -> None:
        self.observe(60, 61)
        self.controller.force_profile('powersave')
        self.controller.disable(restore_balanced=True)
        self.assertEqual(self.tuned.profile, 'balanced')

    def test_profile_and_configuration_allowlists(self) -> None:
        self.observe(60, 61)
        with self.assertRaises(PolicyError):
            self.controller.force_profile('performance')
        with self.assertRaises(PolicyError):
            replace(self.config, recovery_threshold_c=90).validate()
        with self.assertRaises(PolicyError):
            replace(
                self.config,
                normal_profile='powersave',
                hot_profile='balanced',
            ).validate()

    def test_history_is_bounded_and_limit_is_validated(self) -> None:
        controller = PolicyController(
            self.config, self.tuned, now=self.clock, history_limit=3)
        for _index in range(5):
            controller.pause(60)
            controller.resume()
        self.assertEqual(len(controller.history(3)), 3)
        with self.assertRaises(PolicyError):
            controller.history(201)

    def test_only_bounded_history_survives_service_restart(self) -> None:
        self.controller.pause(60)
        history = self.controller.history(20)
        restarted = PolicyController(
            self.config, self.tuned, now=self.clock, history_limit=3)
        restarted.restore_history([{'unrecognised': True}, *history] * 5)
        self.assertLessEqual(len(restarted.history(3)), 3)
        self.assertEqual(restarted.policy_mode, 'automatic')
        self.assertIsNone(restarted.paused_until)


class ConfigurationFileTests(unittest.TestCase):
    def test_polkit_authorisation_reply_uses_struct_signature(self) -> None:
        try:
            from gi.repository import GLib
            from auto_powersaver.service import AutoPowersaverService
        except (ImportError, ValueError) as error:
            self.skipTest(f'GIO bindings are unavailable: {error}')

        class FakeConnection:
            def call_sync(
                self, _bus_name, _object_path, _interface_name, _method_name,
                _parameters, reply_type, _flags, _timeout, _cancellable,
            ):
                self.reply_type = reply_type.dup_string()
                return GLib.Variant('((bba{ss}))', ((True, False, {}),))

        service = AutoPowersaverService.__new__(AutoPowersaverService)
        service._connection = FakeConnection()

        service._authorise(':1.123')

        self.assertEqual(service._connection.reply_type, '((bba{ss}))')

    def test_default_configuration_file_loads(self) -> None:
        try:
            from auto_powersaver.service import load_config
        except (ImportError, ValueError) as error:
            self.skipTest(f'GIO bindings are unavailable: {error}')
        config = load_config(Path('data/auto-powersaver.conf'))
        self.assertEqual(config.hot_threshold_c, 82)
        self.assertEqual(config.recovery_threshold_c, 72)
        self.assertTrue(config.hot_protection_when_disabled)

    def test_missing_hot_protection_setting_migrates_to_safe_default(self) -> None:
        try:
            from auto_powersaver.service import load_config
        except (ImportError, ValueError) as error:
            self.skipTest(f'GIO bindings are unavailable: {error}')
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / 'auto-powersaver.conf'
            path.write_text('[auto_powersaver]\nenabled = false\n', encoding='utf-8')
            config = load_config(path)
        self.assertFalse(config.enabled)
        self.assertTrue(config.hot_protection_when_disabled)

    def test_configuration_round_trip_is_validated(self) -> None:
        try:
            from auto_powersaver.service import load_config, save_config
        except (ImportError, ValueError) as error:
            self.skipTest(f'GIO bindings are unavailable: {error}')
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / 'auto-powersaver.conf'
            expected = Config(hot_threshold_c=85, recovery_threshold_c=70)

            save_config(expected, path)
            actual = load_config(path)

        self.assertEqual(actual, expected)

    def test_unrecognised_configuration_fails_visibly(self) -> None:
        try:
            from auto_powersaver.service import load_config
        except (ImportError, ValueError) as error:
            self.skipTest(f'GIO bindings are unavailable: {error}')
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / 'auto-powersaver.conf'
            path.write_text(
                '[auto_powersaver]\nunsafe_typo = true\n', encoding='utf-8')
            with self.assertRaises(PolicyError):
                load_config(path)

    def test_tuned_adapter_rejects_unapproved_profile_before_execution(self) -> None:
        try:
            from auto_powersaver.service import TunedAdmAdapter
        except (ImportError, ValueError) as error:
            self.skipTest(f'GIO bindings are unavailable: {error}')
        with self.assertRaises(PolicyError):
            TunedAdmAdapter().set_profile('performance; touch /tmp/unsafe')

    def test_cli_rejects_unapproved_profile_without_contacting_dbus(self) -> None:
        completed = subprocess.run(
            [sys.executable, 'bin/fedorausage', 'auto-powersaver', 'force',
             'performance'],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn('invalid choice', completed.stderr)

    def test_cli_rejects_unsafe_thresholds_without_contacting_dbus(self) -> None:
        completed = subprocess.run(
            [sys.executable, 'bin/fedorausage', 'auto-powersaver',
             'set-thresholds', '70', '80'],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn('recovery', completed.stderr)

    def test_cli_help_exposes_three_operating_modes(self) -> None:
        completed = subprocess.run(
            [sys.executable, 'bin/fedorausage', 'auto-powersaver', '--help'],
            capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0)
        self.assertIn('mode', completed.stdout)
        self.assertIn('disable-policy', completed.stdout)
        self.assertIn('conflicts', completed.stdout)

    def test_dbus_and_gnome_clients_expose_operating_modes(self) -> None:
        service_source = Path('auto_powersaver/service.py').read_text(encoding='utf-8')
        preferences_source = Path('prefs.js').read_text(encoding='utf-8')
        extension_source = Path('extension.js').read_text(encoding='utf-8')
        self.assertIn('SetOperatingMode', service_source)
        self.assertIn('SetHotProtectionWhenDisabled', service_source)
        self.assertIn('GetConflictStatus', service_source)
        self.assertIn('RescanConflicts', service_source)
        for source in (preferences_source, extension_source):
            self.assertIn('Operating mode', source)
            self.assertIn('Hot protection only', source)
        self.assertNotIn('Automatically manage power profile', preferences_source)
        self.assertNotIn('Thermal protection while off', extension_source)
        self.assertIn('Hot protection selected Power Saver', extension_source)

    def test_panel_readings_have_stable_order_and_compact_fields(self) -> None:
        extension_source = Path('extension.js').read_text(encoding='utf-8')
        stylesheet_source = Path('stylesheet.css').read_text(encoding='utf-8')
        ordered_additions = [
            'this._panelBox.add_child(this._fanBox);',
            'this._panelBox.add_child(this._memoryBox);',
            'this._panelBox.add_child(labels.box);',
            'this._panelBox.add_child(this._autoPowersaverBox);',
            'this._panelBox.add_child(this._temperatureBox);',
        ]
        positions = [extension_source.index(line) for line in ordered_additions]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn('set_child_at_index', extension_source)
        self.assertIn('system-usage-hottest-temperature', stylesheet_source)
        self.assertIn("style_class: 'system-usage-field'", extension_source)
        self.assertIn('.system-usage-field-icon', stylesheet_source)
        self.assertIn('.system-usage-percent', stylesheet_source)
        self.assertIn('.system-usage-temperature-value', stylesheet_source)
        self.assertIn('.system-usage-fan-speed', stylesheet_source)
        self.assertIn("return `${sensor.friendlyIcon} ", extension_source)
        self.assertIn('spacing: 0', stylesheet_source)
        self.assertIn('text-align: left', stylesheet_source)

    def test_privilege_policy_xml_is_well_formed(self) -> None:
        for path in [
            'data/net.crunchycodes.FedoraUsage.AutoPowersaver1.conf',
            'data/net.crunchycodes.fedorausage.policy',
        ]:
            ElementTree.parse(path)

    def test_hwmon_reader_uses_only_approved_sensor_identities(self) -> None:
        try:
            from auto_powersaver.service import HwmonReader
        except (ImportError, ValueError) as error:
            self.skipTest(f'GIO bindings are unavailable: {error}')
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)

            def add_sensor(directory: str, chip: str, label: str, value: str) -> None:
                sensor_directory = root / directory
                sensor_directory.mkdir()
                (sensor_directory / 'name').write_text(chip, encoding='utf-8')
                (sensor_directory / 'temp1_label').write_text(label, encoding='utf-8')
                (sensor_directory / 'temp1_input').write_text(value, encoding='utf-8')

            add_sensor('hwmon0', 'k10temp', 'Tctl', '64000')
            add_sensor('hwmon1', 'cros_ec', 'cpu@4c', '67000')
            add_sensor('hwmon2', 'amdgpu', 'edge', '47000')
            add_sensor('hwmon3', 'unapproved', 'CPU', '99000')
            sensor_readings = HwmonReader(root).read()

        self.assertEqual(sensor_readings['k10temp/Tctl'].temperature_c, 64)
        self.assertEqual(sensor_readings['cros_ec/cpu@4c'].temperature_c, 67)
        self.assertEqual(sensor_readings['amdgpu/edge'].temperature_c, 47)
        self.assertEqual(len(sensor_readings), 3)

    def test_hwmon_reader_rejects_implausible_and_malformed_values(self) -> None:
        try:
            from auto_powersaver.service import HwmonReader
        except (ImportError, ValueError) as error:
            self.skipTest(f'GIO bindings are unavailable: {error}')
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            for index, (chip, label, value) in enumerate([
                ('k10temp', 'Tctl', '200000'),
                ('cros_ec', 'cpu@4c', 'not-a-number'),
            ]):
                sensor_directory = root / f'hwmon{index}'
                sensor_directory.mkdir()
                (sensor_directory / 'name').write_text(chip, encoding='utf-8')
                (sensor_directory / 'temp1_label').write_text(label, encoding='utf-8')
                (sensor_directory / 'temp1_input').write_text(value, encoding='utf-8')
            sensor_readings = HwmonReader(root).read()

        self.assertFalse(sensor_readings['k10temp/Tctl'].valid)
        self.assertFalse(sensor_readings['cros_ec/cpu@4c'].valid)


class FakeConflictAdapter:
    def __init__(self, candidates, *, active=(), enabled=(), incomplete=False):
        self._candidates = candidates
        scopes = {
            Path(name).name: scope for name, _kind, scope, _text in candidates
        }
        self._active = {
            value if isinstance(value, tuple) else (scopes[value], value)
            for value in active
        }
        self._enabled = {
            value if isinstance(value, tuple) else (scopes[value], value)
            for value in enabled
        }
        self.incomplete = incomplete

    def candidates(self):
        return [(Path(name), kind, scope) for name, kind, scope, _text in self._candidates]

    def read_text(self, path):
        for name, _kind, _scope, text in self._candidates:
            if Path(name) == path:
                return text
        self.incomplete = True
        return None

    def systemd_state(self):
        return self._active, self._enabled, not self.incomplete


class ConflictScannerTests(unittest.TestCase):
    def scan(self, candidates, *, active=(), enabled=(), incomplete=False):
        adapter = FakeConflictAdapter(
            candidates, active=active, enabled=enabled, incomplete=incomplete)
        return ConflictScanner(adapter).scan()

    def test_excludes_fedorausage_and_tuned_components(self) -> None:
        result = self.scan([
            ('fedorausage-auto-powersaver.service', 'systemd_unit', 'system',
             'ExecStart=/usr/bin/tuned-adm profile powersave'),
            ('tuned.service', 'systemd_unit', 'system',
             'ExecStart=/usr/bin/tuned-adm profile balanced'),
            ('tuned-ppd.service', 'systemd_unit', 'system',
             'ExecStart=/usr/bin/powerprofilesctl set balanced'),
            ('manual-auto-powersaver-test.sh', 'script', 'system',
             '/usr/bin/tuned-adm profile powersave'),
        ])
        self.assertEqual(result['potential_competing_controller_count'], 0)

    def test_active_legacy_controller_is_high_confidence(self) -> None:
        result = self.scan([
            ('framework-thermal-policy.service', 'systemd_unit', 'system',
             'ExecStart=/usr/local/bin/framework-policy'),
        ], active=('framework-thermal-policy.service',))
        finding = result['potential_competing_controllers'][0]
        self.assertEqual(finding['confidence'], 'high')
        self.assertEqual(finding['risk'], 'active_competitor')
        self.assertEqual(result['status'], 'high_risk')

    def test_inactive_legacy_controller_is_historical(self) -> None:
        result = self.scan([
            ('framework-thermal-policy.service', 'systemd_unit', 'system', ''),
        ])
        finding = result['potential_competing_controllers'][0]
        self.assertEqual(finding['confidence'], 'low')
        self.assertEqual(finding['risk'], 'inactive_historical')

    def test_active_profile_changing_system_and_user_units_are_detected(self) -> None:
        result = self.scan([
            ('custom-power-policy.service', 'systemd_unit', 'system',
             'ExecStart=/usr/bin/tuned-adm profile powersave'),
            ('user-power.timer', 'systemd_unit', 'user',
             'ExecStart=/usr/bin/powerprofilesctl set balanced'),
        ], active=('custom-power-policy.service', 'user-power.timer'))
        self.assertEqual(result['potential_competing_controller_count'], 2)
        self.assertTrue(all(
            item['confidence'] == 'high'
            for item in result['potential_competing_controllers']))

    def test_timer_and_referenced_script_are_correlated_read_only(self) -> None:
        result = self.scan([
            ('night-power.timer', 'systemd_unit', 'system',
             '[Timer]\nOnCalendar=daily'),
            ('night-power.service', 'systemd_unit', 'system',
             'ExecStart=/usr/local/bin/night-power'),
            ('/usr/local/bin/night-power', 'script', 'system',
             '#!/bin/sh\ntuned-adm profile powersave'),
        ], active=('night-power.timer',), enabled=('night-power.timer',))
        findings = {
            item['name']: item for item in result['potential_competing_controllers']
        }
        self.assertEqual(findings['night-power.timer']['confidence'], 'high')
        self.assertEqual(findings['night-power.timer']['risk'], 'active_competitor')
        self.assertIn(
            'references script', ' '.join(findings['night-power.service']['evidence']))

    def test_cron_autostart_tlp_and_ppd_are_detected(self) -> None:
        result = self.scan([
            ('profile-cron', 'cron', 'system', 'tuned-adm profile powersave'),
            ('power.desktop', 'autostart', 'user',
             'Exec=powerprofilesctl set balanced'),
            ('tlp.service', 'systemd_unit', 'system', 'ExecStart=/usr/sbin/tlp init'),
            ('power-profiles-daemon.service', 'systemd_unit', 'system',
             'ExecStart=/usr/libexec/power-profiles-daemon'),
        ], active=('tlp.service', 'power-profiles-daemon.service'))
        self.assertEqual(result['potential_competing_controller_count'], 4)
        known = {item['name']: item for item in result['potential_competing_controllers']}
        self.assertEqual(known['tlp.service']['confidence'], 'high')
        self.assertEqual(
            known['power-profiles-daemon.service']['risk'], 'active_competitor')

    def test_name_alone_does_not_make_unknown_unit_a_finding(self) -> None:
        result = self.scan([
            ('power-report.service', 'systemd_unit', 'system',
             'ExecStart=/usr/bin/logger power report'),
        ], active=('power-report.service',))
        self.assertEqual(result['potential_competing_controller_count'], 0)

    def test_duplicate_findings_merge_and_limits_are_enforced(self) -> None:
        duplicate = ('controller.service', 'systemd_unit', 'system',
                     'ExecStart=tuned-adm profile balanced')
        result = self.scan([duplicate, duplicate])
        self.assertEqual(result['potential_competing_controller_count'], 1)
        many = [
            (f'controller-{index}.service', 'systemd_unit', 'system',
             'ExecStart=tuned-adm profile balanced')
            for index in range(MAX_FINDINGS + 10)
        ]
        limited = self.scan(many)
        self.assertEqual(limited['potential_competing_controller_count'], MAX_FINDINGS)
        self.assertFalse(limited['scan_complete'])

    def test_incomplete_scan_is_reported_without_failure(self) -> None:
        result = self.scan([], incomplete=True)
        self.assertFalse(result['scan_complete'])
        self.assertEqual(result['status'], 'scan_incomplete')

    def test_system_and_user_unit_states_do_not_collide(self) -> None:
        result = self.scan([
            ('/etc/systemd/system/custom-power.service', 'systemd_unit', 'system',
             'ExecStart=tuned-adm profile powersave'),
            ('/home/test/.config/systemd/user/custom-power.service',
             'systemd_unit', 'user', 'ExecStart=tuned-adm profile powersave'),
        ], active=(('user', 'custom-power.service'),))
        findings = {
            item['scope']: item for item in result['potential_competing_controllers']
        }
        self.assertFalse(findings['system']['active'])
        self.assertTrue(findings['user']['active'])

    def test_host_adapter_parses_only_active_systemd_units(self) -> None:
        outputs = iter([
            'active.service enabled enabled\ninactive.service disabled disabled\n',
            'active.service loaded active running Active\n'
            'inactive.service loaded inactive dead Inactive\n',
        ])

        def run(*_args, **_kwargs):
            return subprocess.CompletedProcess([], 0, next(outputs), '')

        adapter = HostConflictAdapter()
        with patch.dict('os.environ', {'XDG_RUNTIME_DIR': ''}), patch(
            'auto_powersaver.conflicts.subprocess.run', side_effect=run,
        ):
            active, enabled, complete = adapter.systemd_state()

        self.assertTrue(complete)
        self.assertEqual(active, {('system', 'active.service')})
        self.assertEqual(enabled, {('system', 'active.service')})

    def test_host_adapter_skips_uninstantiated_templates_in_details(self) -> None:
        commands = []

        def run(command, **_kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, '', '')

        adapter = HostConflictAdapter()
        with patch.dict('os.environ', {'XDG_RUNTIME_DIR': ''}), patch(
            'auto_powersaver.conflicts.subprocess.run', side_effect=run,
        ):
            _details, complete = adapter.systemd_details([
                ('alsa-card-wait@.service', 'system'),
                ('maintenance@.timer', 'system'),
                ('maintenance@daily.timer', 'system'),
                ('regular.service', 'system'),
            ])

        self.assertTrue(complete)
        self.assertEqual(len(commands), 1)
        self.assertNotIn('alsa-card-wait@.service', commands[0])
        self.assertNotIn('maintenance@.timer', commands[0])
        self.assertIn('maintenance@daily.timer', commands[0])
        self.assertIn('regular.service', commands[0])

    def test_host_adapter_skips_large_binary_without_incomplete_scan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            binary = Path(temporary_directory) / 'controller'
            binary.write_bytes(b'\x7fELF\0' + b'x' * 70_000)
            adapter = HostConflictAdapter()
            self.assertIsNone(adapter.read_text(binary))
            self.assertFalse(adapter.incomplete)

    def test_systemd_location_uses_larger_bounded_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            units = root / 'units'
            units.mkdir()
            (root / 'homes').mkdir()
            for index in range(257):
                (units / f'test-{index}.service').touch()
            adapter = HostConflictAdapter(
                systemd_locations=(units,), script_locations=(),
                cron_locations=(), autostart_locations=(),
                user_homes_root=root / 'homes')
            candidates = adapter.candidates()
        self.assertEqual(len(candidates), 257)
        self.assertFalse(adapter.incomplete)

    def test_host_adapter_does_not_follow_candidates_outside_allowlisted_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            allowed = root / 'units'
            allowed.mkdir()
            outside = root / 'unrelated.service'
            outside.write_text(
                'ExecStart=/usr/bin/tuned-adm profile powersave', encoding='utf-8')
            (allowed / 'linked.service').symlink_to(outside)
            adapter = HostConflictAdapter(
                systemd_locations=(allowed,), script_locations=(),
                cron_locations=(), autostart_locations=(),
                user_homes_root=root / 'no-homes')
            candidates = adapter.candidates()
        self.assertEqual(candidates, [])


if __name__ == '__main__':
    unittest.main()
