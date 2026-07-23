# SPDX-License-Identifier: GPL-3.0-or-later

from dataclasses import replace
import tempfile
from pathlib import Path
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ElementTree

from auto_powersaver.core import Config, PolicyController, PolicyError, SensorReading


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
        self.tuned.profile = 'powersave'
        self.observe(60, 61)
        self.assertEqual(self.controller.policy_mode, 'manual_override')
        self.assertEqual(self.controller.manual_override_profile, 'powersave')
        self.assertEqual(
            self.controller.last_transition['reason'], 'external_profile_change')

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


if __name__ == '__main__':
    unittest.main()
