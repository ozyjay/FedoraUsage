# SPDX-License-Identifier: GPL-3.0-or-later
"""Pure policy engine for FedoraUsage Auto-Powersaver.

This module deliberately has no D-Bus, systemd, sensor-file or TuneD
dependencies.  The privileged service owns those adapters while tests can
exercise every policy transition without changing the host power profile.
"""

from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Callable, Mapping, Protocol
import uuid


ALLOWED_PROFILES = frozenset({'balanced', 'powersave'})
CONTROL_SENSORS = ('k10temp/Tctl', 'cros_ec/cpu@4c')
DIAGNOSTIC_SENSOR = 'amdgpu/edge'
MINIMUM_TEMPERATURE_C = -20.0
MAXIMUM_TEMPERATURE_C = 125.0
MAXIMUM_PAUSE_SECONDS = 86_400
MAXIMUM_HISTORY_LIMIT = 200
PENDING_TRANSITION_SECONDS = 15


class PolicyError(ValueError):
    """Raised when a requested policy operation is unsafe or invalid."""


class TunedAdapter(Protocol):
    def set_profile(self, profile: str) -> str:
        """Select a profile and return the verified resulting profile."""


@dataclass(frozen=True)
class Config:
    enabled: bool = True
    normal_profile: str = 'balanced'
    hot_profile: str = 'powersave'
    hot_threshold_c: float = 82.0
    recovery_threshold_c: float = 72.0
    poll_interval_seconds: int = 5
    recovery_dwell_seconds: int = 30
    recovery_reading_count: int = 3
    manual_override_seconds: int = 1800
    allow_single_sensor_degraded_operation: bool = True
    disable_behavior: str = 'leave_unchanged'
    hot_protection_when_disabled: bool = True

    def validate(self) -> None:
        if self.normal_profile != 'balanced':
            raise PolicyError('normal profile must be balanced')
        if self.hot_profile != 'powersave':
            raise PolicyError('hot profile must be powersave')
        if not 40 <= self.hot_threshold_c <= 110:
            raise PolicyError('hot threshold must be between 40°C and 110°C')
        if not 30 <= self.recovery_threshold_c < self.hot_threshold_c:
            raise PolicyError(
                'recovery threshold must be at least 30°C and below the hot threshold')
        if not 1 <= self.poll_interval_seconds <= 60:
            raise PolicyError('poll interval must be between 1 and 60 seconds')
        if not 0 <= self.recovery_dwell_seconds <= 3600:
            raise PolicyError('recovery dwell must be between 0 and 3600 seconds')
        if not 1 <= self.recovery_reading_count <= 100:
            raise PolicyError('recovery reading count must be between 1 and 100')
        if not 60 <= self.manual_override_seconds <= MAXIMUM_PAUSE_SECONDS:
            raise PolicyError('manual override must be between 60 seconds and 24 hours')
        if self.disable_behavior not in {'leave_unchanged', 'balanced'}:
            raise PolicyError('disable behaviour must be leave_unchanged or balanced')


@dataclass(frozen=True)
class SensorReading:
    temperature_c: float | None
    valid: bool
    age_seconds: float = 0.0
    error: str | None = None
    diagnostic_only: bool = False

    @classmethod
    def valid_temperature(
        cls, temperature_c: float, *, diagnostic_only: bool = False,
    ) -> 'SensorReading':
        valid = (
            isinstance(temperature_c, (int, float)) and
            MINIMUM_TEMPERATURE_C <= float(temperature_c) <= MAXIMUM_TEMPERATURE_C
        )
        return cls(
            float(temperature_c) if valid else None,
            valid,
            error=None if valid else 'temperature is outside the plausible range',
            diagnostic_only=diagnostic_only,
        )


def _utc_timestamp(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, timezone.utc).isoformat()


class PolicyController:
    """Authoritative temperature-driven profile state machine."""

    def __init__(
        self,
        config: Config,
        tuned: TunedAdapter,
        *,
        now: Callable[[], float],
        history_limit: int = MAXIMUM_HISTORY_LIMIT,
    ) -> None:
        config.validate()
        self.config = config
        self._tuned = tuned
        self._now = now
        self._history: deque[dict] = deque(maxlen=min(max(history_limit, 1), 1000))
        self.policy_mode = 'automatic' if config.enabled else 'disabled'
        self.thermal_state = 'unknown'
        self.telemetry_quality = 'unknown'
        self.service_health = 'healthy'
        self.active_profile: str | None = None
        self.control_temperature_c: float | None = None
        self.sensor_readings: dict[str, SensorReading] = {}
        self.effective_profile_reason = 'starting'
        self.paused_until: float | None = None
        self.paused_previous_mode: str | None = None
        self.manual_override_profile: str | None = None
        self.manual_override_until: float | None = None
        self.pending_transition: dict | None = None
        self.last_transition: dict | None = None
        self.last_error: str | None = None
        self.tuned_available = True
        self.hot_latched = False
        self._recovery_started_at: float | None = None
        self._recovery_readings = 0
        self._last_observed_at: float | None = None

    @property
    def enabled(self) -> bool:
        return self.config.enabled

    def replace_config(self, config: Config) -> None:
        config.validate()
        self.config = config
        if not config.enabled:
            self.policy_mode = 'disabled'
            self.paused_until = None
            self.paused_previous_mode = None
            self.manual_override_until = None
            self.manual_override_profile = None

    def observe(
        self,
        readings: Mapping[str, SensorReading],
        active_profile: str | None,
        *,
        tuned_available: bool = True,
        tuned_error: str | None = None,
    ) -> None:
        now = self._now()
        self._last_observed_at = now
        previous_profile = self.active_profile
        self.sensor_readings = dict(readings)
        self.tuned_available = tuned_available

        if not tuned_available or active_profile is None:
            self.service_health = 'tuned_unavailable'
            self.last_error = tuned_error or 'TuneD is unavailable'
        else:
            self.service_health = 'healthy'
            if self.last_error == 'TuneD is unavailable' or self.last_error == tuned_error:
                self.last_error = None

        self._expire_temporary_mode(now)
        self._classify_profile_observation(previous_profile, active_profile, now)
        self.active_profile = active_profile
        valid_control = [
            reading.temperature_c
            for name, reading in readings.items()
            if name in CONTROL_SENSORS and reading.valid and
            reading.temperature_c is not None
        ]
        valid_count = len(valid_control)

        if valid_count == len(CONTROL_SENSORS):
            self.telemetry_quality = 'healthy'
            self.control_temperature_c = max(valid_control)
        elif valid_count == 1 and self.config.allow_single_sensor_degraded_operation:
            self.telemetry_quality = 'degraded'
            self.control_temperature_c = valid_control[0]
        else:
            self.telemetry_quality = 'unknown'
            self.control_temperature_c = None

        telemetry_error = 'No approved control sensors are available'
        if self.telemetry_quality == 'unknown' and tuned_available:
            self.service_health = 'fault'
            self.last_error = telemetry_error
        elif self.last_error == telemetry_error:
            self.service_health = 'healthy'
            self.last_error = None

        self._apply_thermal_policy(now)

    def _classify_profile_observation(
        self, previous_profile: str | None, observed_profile: str | None, now: float,
    ) -> None:
        if observed_profile is None or previous_profile is None or observed_profile == previous_profile:
            return

        if self.pending_transition is not None:
            pending_age = now - self.pending_transition['requested_at_epoch']
            if (
                observed_profile == self.pending_transition['requested_profile'] and
                pending_age <= PENDING_TRANSITION_SECONDS
            ):
                pending = self.pending_transition
                self.pending_transition = None
                self._record_event(
                    transition_id=pending['transition_id'],
                    reason=pending['reason'],
                    source='automatic',
                    success=True,
                    previous_profile=previous_profile,
                    requested_profile=observed_profile,
                    resulting_profile=observed_profile,
                    verification_result='verified by subsequent TuneD observation',
                )
                return

        if self.config.enabled:
            before_mode = self.policy_mode
            self.policy_mode = 'manual_override'
            self.manual_override_profile = observed_profile
            self.manual_override_until = now + self.config.manual_override_seconds
            self.paused_until = None
            self.paused_previous_mode = None
            self._record_event(
                reason='external_profile_change',
                source='external',
                success=True,
                previous_profile=previous_profile,
                requested_profile=observed_profile,
                resulting_profile=observed_profile,
                policy_mode_before=before_mode,
            )

    def _expire_temporary_mode(self, now: float) -> None:
        if self.policy_mode == 'paused' and self.paused_until is not None and now >= self.paused_until:
            self._resume_from_pause(
                'pause_expired', 'automatic', apply_profile=False)
        elif (
            self.policy_mode == 'manual_override' and
            self.manual_override_until is not None and
            now >= self.manual_override_until
        ):
            before_mode = self.policy_mode
            self.policy_mode = 'automatic'
            self.manual_override_until = None
            self.manual_override_profile = None
            self._record_event(
                reason='manual_override_expired', source='automatic', success=True,
                policy_mode_before=before_mode)

    def _apply_thermal_policy(self, now: float) -> None:
        temperature = self.control_temperature_c
        safety_enabled = self.config.enabled or self.config.hot_protection_when_disabled

        if temperature is None:
            self.thermal_state = 'hot' if self.hot_latched else 'unknown'
            self._reset_recovery()
            return

        if temperature >= self.config.hot_threshold_c:
            self.thermal_state = 'hot'
            self.hot_latched = True
            self._reset_recovery()
            if safety_enabled and self.tuned_available:
                self._request_profile(
                    self.config.hot_profile, 'hot_threshold_exceeded', 'safety')
            return

        if self.hot_latched:
            self.thermal_state = 'hot'
            if temperature > self.config.recovery_threshold_c:
                self._reset_recovery()
                return

            if self.telemetry_quality == 'unknown':
                self._reset_recovery()
                return

            if self._recovery_started_at is None:
                self._recovery_started_at = now
                self._recovery_readings = 1
            else:
                self._recovery_readings += 1

            dwell_satisfied = now - self._recovery_started_at >= self.config.recovery_dwell_seconds
            count_satisfied = self._recovery_readings >= self.config.recovery_reading_count
            if not (dwell_satisfied and count_satisfied):
                return

            self.hot_latched = False
            self._reset_recovery()
            self.thermal_state = (
                'telemetry_degraded' if self.telemetry_quality == 'degraded' else 'normal')
            self._apply_mode_profile(reason='validated_recovery', source='recovery')
            return

        self.thermal_state = (
            'telemetry_degraded' if self.telemetry_quality == 'degraded' else 'normal')
        self._reset_recovery()
        self._apply_mode_profile(reason='policy_evaluation', source='automatic')

    def _apply_mode_profile(self, *, reason: str, source: str) -> None:
        if not self.tuned_available:
            return
        if self.policy_mode == 'automatic':
            self._request_profile(self.config.normal_profile, reason, source)
        elif self.policy_mode == 'manual_override' and self.manual_override_profile in ALLOWED_PROFILES:
            self._request_profile(self.manual_override_profile, reason, source)

    def _reset_recovery(self) -> None:
        self._recovery_started_at = None
        self._recovery_readings = 0

    def _request_profile(self, profile: str, reason: str, source: str) -> None:
        if profile not in ALLOWED_PROFILES:
            raise PolicyError('only balanced and powersave may be selected')
        if self.active_profile == profile:
            self.effective_profile_reason = reason
            return
        if self.pending_transition is not None:
            pending_age = self._now() - self.pending_transition['requested_at_epoch']
            if (
                self.pending_transition['requested_profile'] == profile and
                pending_age <= PENDING_TRANSITION_SECONDS
            ):
                if self.pending_transition.get('failed'):
                    self.service_health = 'fault'
                return
            if pending_age > PENDING_TRANSITION_SECONDS:
                self.pending_transition = None

        previous_profile = self.active_profile
        transition_id = str(uuid.uuid4())
        self.pending_transition = {
            'transition_id': transition_id,
            'requested_profile': profile,
            'previous_profile': previous_profile,
            'requested_at_epoch': self._now(),
            'reason': reason,
        }
        try:
            resulting_profile = self._tuned.set_profile(profile)
            success = resulting_profile == profile
            if not success:
                raise RuntimeError(
                    f'TuneD reported {resulting_profile!r} after requesting {profile!r}')
            self.active_profile = resulting_profile
            self.pending_transition = None
            self.effective_profile_reason = reason
            self.last_error = None
            self._record_event(
                transition_id=transition_id,
                reason=reason,
                source=source,
                success=True,
                previous_profile=previous_profile,
                requested_profile=profile,
                resulting_profile=resulting_profile,
            )
        except Exception as error:
            self.service_health = 'fault'
            self.last_error = str(error)
            self.pending_transition['failed'] = True
            self._record_event(
                transition_id=transition_id,
                reason=reason,
                source='fault',
                success=False,
                previous_profile=previous_profile,
                requested_profile=profile,
                resulting_profile=self.active_profile,
                verification_result=str(error),
            )

    def enable(self) -> None:
        before_mode = self.policy_mode
        self.config = Config(**{**asdict(self.config), 'enabled': True})
        self.policy_mode = 'automatic'
        self.paused_until = None
        self.paused_previous_mode = None
        self.manual_override_until = None
        self.manual_override_profile = None
        self._record_event(reason='enabled', source='user', success=True,
                           policy_mode_before=before_mode)
        if self.hot_latched:
            self._request_profile(
                self.config.hot_profile, 'enabled_while_hot', 'safety')
        else:
            self._apply_mode_profile(reason='enabled', source='user')

    def disable(self, restore_balanced: bool = False) -> None:
        if restore_balanced and (self.hot_latched or self.control_temperature_c is None):
            raise PolicyError('Balanced cannot be selected while hot or telemetry is unavailable')
        if (
            restore_balanced and
            (self._last_observed_at is None or
             self._now() - self._last_observed_at > self.config.poll_interval_seconds * 2)
        ):
            raise PolicyError('Balanced cannot be selected while telemetry is stale')
        before_mode = self.policy_mode
        self.config = Config(**{**asdict(self.config), 'enabled': False})
        self.policy_mode = 'disabled'
        self.paused_until = None
        self.paused_previous_mode = None
        self.manual_override_until = None
        self.manual_override_profile = None
        self._record_event(reason='disabled', source='user', success=True,
                           policy_mode_before=before_mode)
        if restore_balanced:
            self._request_profile(
                self.config.normal_profile, 'disabled_and_balanced', 'user')

    def pause(self, duration_seconds: int) -> None:
        if not self.config.enabled:
            raise PolicyError('Auto-Powersaver must be enabled before it can be paused')
        if not 60 <= duration_seconds <= MAXIMUM_PAUSE_SECONDS:
            raise PolicyError('pause duration must be between 60 seconds and 24 hours')
        before_mode = self.policy_mode
        if before_mode != 'paused':
            self.paused_previous_mode = (
                before_mode if before_mode in {'automatic', 'manual_override'}
                else 'automatic')
        self.policy_mode = 'paused'
        self.paused_until = self._now() + duration_seconds
        if self.paused_previous_mode != 'manual_override':
            self.manual_override_until = None
            self.manual_override_profile = None
        self._record_event(reason=f'paused_{duration_seconds}_seconds', source='user',
                           success=True, policy_mode_before=before_mode)

    def resume(self) -> None:
        if not self.config.enabled:
            raise PolicyError('Auto-Powersaver is disabled')
        if self.policy_mode != 'paused':
            raise PolicyError('Auto-Powersaver is not paused')
        self._resume_from_pause('resumed', 'user')

    def _resume_from_pause(
        self, reason: str, source: str, *, apply_profile: bool = True,
    ) -> None:
        before_mode = self.policy_mode
        resume_mode = self.paused_previous_mode or 'automatic'
        if (
            resume_mode == 'manual_override' and
            (self.manual_override_until is None or
             self.manual_override_until <= self._now())
        ):
            resume_mode = 'automatic'
            self.manual_override_until = None
            self.manual_override_profile = None
        self.policy_mode = resume_mode
        self.paused_until = None
        self.paused_previous_mode = None
        self._record_event(reason=reason, source=source, success=True,
                           policy_mode_before=before_mode)
        if apply_profile and not self.hot_latched:
            self._apply_mode_profile(reason=reason, source=source)

    def return_to_automatic(self) -> None:
        if not self.config.enabled:
            raise PolicyError('Auto-Powersaver is disabled')
        before_mode = self.policy_mode
        self.policy_mode = 'automatic'
        self.paused_until = None
        self.paused_previous_mode = None
        self.manual_override_until = None
        self.manual_override_profile = None
        self._record_event(reason='returned_to_automatic', source='user', success=True,
                           policy_mode_before=before_mode)
        if not self.hot_latched:
            self._apply_mode_profile(reason='returned_to_automatic', source='user')

    def force_profile(self, profile: str) -> None:
        if profile not in ALLOWED_PROFILES:
            raise PolicyError('only balanced and powersave may be selected')
        if profile == 'balanced' and (self.hot_latched or self.control_temperature_c is None):
            raise PolicyError('Balanced cannot be selected while hot or telemetry is unavailable')
        if (
            profile == 'balanced' and
            (self._last_observed_at is None or
             self._now() - self._last_observed_at > self.config.poll_interval_seconds * 2)
        ):
            raise PolicyError('Balanced cannot be selected while telemetry is stale')
        if not self.config.enabled:
            raise PolicyError('Auto-Powersaver is disabled')
        before_mode = self.policy_mode
        self.policy_mode = 'manual_override'
        self.manual_override_profile = profile
        self.manual_override_until = self._now() + self.config.manual_override_seconds
        self.paused_until = None
        self.paused_previous_mode = None
        self._record_event(reason=f'manual_{profile}', source='user', success=True,
                           policy_mode_before=before_mode)
        self._request_profile(profile, f'manual_{profile}', 'user')

    def set_thresholds(self, hot_c: float, recovery_c: float) -> None:
        updated = Config(**{
            **asdict(self.config),
            'hot_threshold_c': float(hot_c),
            'recovery_threshold_c': float(recovery_c),
        })
        updated.validate()
        self.config = updated
        self._record_event(reason='thresholds_updated', source='user', success=True)

    def _record_event(
        self,
        *,
        reason: str,
        source: str,
        success: bool,
        transition_id: str | None = None,
        previous_profile: str | None = None,
        requested_profile: str | None = None,
        resulting_profile: str | None = None,
        verification_result: str | None = None,
        policy_mode_before: str | None = None,
    ) -> None:
        event = {
            'transition_id': transition_id or str(uuid.uuid4()),
            'timestamp': _utc_timestamp(self._now()),
            'policy_mode_before': policy_mode_before or self.policy_mode,
            'policy_mode_after': self.policy_mode,
            'thermal_state_before': (
                self.last_transition['thermal_state_after']
                if self.last_transition is not None else self.thermal_state),
            'thermal_state_after': self.thermal_state,
            'service_health_before': (
                self.last_transition['service_health_after']
                if self.last_transition is not None else self.service_health),
            'service_health_after': self.service_health,
            'previous_profile': previous_profile,
            'requested_profile': requested_profile,
            'resulting_profile': resulting_profile,
            'control_temperature_c': self.control_temperature_c,
            'sensor_readings': {
                name: asdict(reading) for name, reading in self.sensor_readings.items()
            },
            'reason': reason,
            'trigger_source': source,
            'success': success,
            'verification_result': verification_result or ('verified' if success else 'failed'),
        }
        self._history.append(event)
        self.last_transition = event

    def history(self, limit: int) -> list[dict]:
        if not 1 <= limit <= MAXIMUM_HISTORY_LIMIT:
            raise PolicyError(f'history limit must be between 1 and {MAXIMUM_HISTORY_LIMIT}')
        return list(self._history)[-limit:]

    def restore_history(self, events: object) -> None:
        """Restore only bounded audit events, never temporary policy state."""
        if not isinstance(events, list):
            return
        for event in events[-self._history.maxlen:]:
            if isinstance(event, dict) and isinstance(event.get('transition_id'), str):
                self._history.append(event)
        if self._history:
            self.last_transition = self._history[-1]

    def status(self) -> dict:
        now = self._now()
        reading_age = (
            max(0.0, now - self._last_observed_at)
            if self._last_observed_at is not None else 0.0)
        return {
            'enabled': self.config.enabled,
            'policy_mode': self.policy_mode,
            'thermal_state': self.thermal_state,
            'telemetry_quality': self.telemetry_quality,
            'telemetry_age_seconds': reading_age,
            'hot_latched': self.hot_latched,
            'service_health': self.service_health,
            'control_temperature_c': self.control_temperature_c,
            'sensor_readings': {
                name: {
                    **asdict(reading),
                    'age_seconds': reading.age_seconds + reading_age,
                }
                for name, reading in self.sensor_readings.items()
            },
            'active_profile': self.active_profile,
            'effective_profile_reason': self.effective_profile_reason,
            'hot_threshold_c': self.config.hot_threshold_c,
            'recovery_threshold_c': self.config.recovery_threshold_c,
            'poll_interval_seconds': self.config.poll_interval_seconds,
            'recovery_dwell_seconds': self.config.recovery_dwell_seconds,
            'recovery_reading_count': self.config.recovery_reading_count,
            'manual_override_seconds': self.config.manual_override_seconds,
            'allow_single_sensor_degraded_operation':
                self.config.allow_single_sensor_degraded_operation,
            'disable_behavior': self.config.disable_behavior,
            'paused_until': (
                _utc_timestamp(self.paused_until) if self.paused_until is not None else None),
            'paused_seconds_remaining': (
                max(0, round(self.paused_until - now)) if self.paused_until is not None else None),
            'paused_previous_mode': self.paused_previous_mode,
            'manual_override_profile': self.manual_override_profile,
            'manual_override_until': (
                _utc_timestamp(self.manual_override_until)
                if self.manual_override_until is not None else None),
            'manual_override_seconds_remaining': (
                max(0, round(self.manual_override_until - now))
                if self.manual_override_until is not None else None),
            'pending_transition_id': (
                self.pending_transition['transition_id']
                if self.pending_transition is not None else None),
            'last_transition': self.last_transition,
            'last_error': self.last_error,
            'service_available': True,
            'tuned_available': self.tuned_available,
        }
