# SPDX-License-Identifier: GPL-3.0-or-later
"""Bounded, read-only discovery of potential power-profile controllers."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import os
import re
import subprocess
from typing import Callable, Iterable


MAX_FILES_PER_LOCATION = 256
MAX_SYSTEMD_FILES_PER_LOCATION = 1024
MAX_FILE_BYTES = 65_536
MAX_FINDINGS = 50
MAX_COMMAND_BYTES = 262_144
UNIT_NAME = re.compile(r'^[A-Za-z0-9_.@:-]+\.(?:service|timer)$')

SYSTEMD_LOCATIONS = (
    Path('/etc/systemd/system'),
    Path('/usr/lib/systemd/system'),
)
SCRIPT_LOCATIONS = (Path('/usr/local/bin'), Path('/usr/local/sbin'))
CRON_LOCATIONS = (
    Path('/etc/cron.d'), Path('/etc/cron.hourly'), Path('/etc/cron.daily'),
    Path('/etc/cron.weekly'), Path('/etc/cron.monthly'),
)
AUTOSTART_LOCATIONS = (Path('/etc/xdg/autostart'),)
KNOWN_UNITS = {
    'framework-thermal-policy.service': 'legacy thermal policy service',
    'tlp.service': 'TLP power-management service',
    'power-profiles-daemon.service': 'power-profiles-daemon service',
}
EXCLUDED_UNITS = {
    'fedorausage-auto-powersaver.service', 'tuned.service', 'tuned-ppd.service',
}
COMMAND_PATTERNS = (
    (re.compile(r'\btuned-adm\s+profile\b', re.I), 'invokes tuned-adm profile'),
    (re.compile(r'\bpowerprofilesctl\s+set\b', re.I), 'invokes powerprofilesctl set'),
    (re.compile(r'\bcpupower\s+frequency-set\b', re.I), 'invokes cpupower frequency-set'),
    (re.compile(r'\bscaling_governor\b', re.I), 'writes or references scaling_governor'),
    (re.compile(r'\benergy_performance_preference\b', re.I),
     'writes or references energy_performance_preference'),
    (re.compile(r'\bamd_pstate\b', re.I), 'writes or references amd_pstate controls'),
)


def _timestamp(now: Callable[[], datetime] | None = None) -> str:
    value = now() if now else datetime.now(timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


class HostConflictAdapter:
    """Read only fixed administrative locations and allowlisted systemctl data."""

    def __init__(
        self,
        *,
        systemd_locations: Iterable[Path] = SYSTEMD_LOCATIONS,
        script_locations: Iterable[Path] = SCRIPT_LOCATIONS,
        cron_locations: Iterable[Path] = CRON_LOCATIONS,
        autostart_locations: Iterable[Path] = AUTOSTART_LOCATIONS,
        user_homes_root: Path = Path('/home'),
    ) -> None:
        self.systemd_locations = tuple(systemd_locations)
        self.script_locations = tuple(script_locations)
        self.cron_locations = tuple(cron_locations)
        self.autostart_locations = tuple(autostart_locations)
        self.user_homes_root = user_homes_root
        self.incomplete = False

    def begin_scan(self) -> None:
        self.incomplete = False

    def _files(
        self, directory: Path, patterns: tuple[str, ...],
        *, limit: int = MAX_FILES_PER_LOCATION,
    ) -> list[Path]:
        try:
            paths = sorted({path for pattern in patterns for path in directory.glob(pattern)})
            if len(paths) > limit:
                self.incomplete = True
            safe_paths = []
            directory_root = directory.resolve()
            for path in paths:
                try:
                    resolved = path.resolve()
                    if not resolved.is_relative_to(directory_root) or not resolved.is_file():
                        continue
                    safe_paths.append(path)
                except OSError:
                    self.incomplete = True
            return safe_paths[:limit]
        except OSError:
            self.incomplete = True
            return []

    def read_text(self, path: Path) -> str | None:
        try:
            with path.open('rb') as handle:
                value = handle.read(MAX_FILE_BYTES + 1)
            if value.startswith(b'\x7fELF') or b'\0' in value[:4096]:
                return None
            if len(value) > MAX_FILE_BYTES:
                self.incomplete = True
                return None
            return value.decode('utf-8', errors='replace')
        except OSError:
            self.incomplete = True
            return None

    def candidates(self) -> list[tuple[Path, str, str]]:
        values: list[tuple[Path, str, str]] = []
        for directory in self.systemd_locations:
            values.extend((path, 'systemd_unit', 'system') for path in
                          self._files(
                              directory, ('*.service', '*.timer'),
                              limit=MAX_SYSTEMD_FILES_PER_LOCATION))
        for directory in self.script_locations:
            values.extend((path, 'script', 'system') for path in self._files(directory, ('*',)))
        for directory in self.cron_locations:
            values.extend((path, 'cron', 'system') for path in self._files(directory, ('*',)))
        for directory in self.autostart_locations:
            values.extend((path, 'autostart', 'system') for path in
                          self._files(directory, ('*.desktop',)))
        try:
            homes = sorted(path for path in self.user_homes_root.iterdir() if path.is_dir())[:32]
        except OSError:
            homes = []
            self.incomplete = True
        for home in homes:
            user_units = home / '.config/systemd/user'
            user_autostart = home / '.config/autostart'
            values.extend((path, 'systemd_unit', 'user') for path in
                          self._files(
                              user_units, ('*.service', '*.timer'),
                              limit=MAX_SYSTEMD_FILES_PER_LOCATION))
            values.extend((path, 'autostart', 'user') for path in
                          self._files(user_autostart, ('*.desktop',)))
        return values

    def systemd_state(self) -> tuple[set[tuple[str, str]], set[tuple[str, str]], bool]:
        active: set[tuple[str, str]] = set()
        enabled: set[tuple[str, str]] = set()
        complete = True
        commands = [
            (['systemctl', 'list-unit-files', '--type=service', '--type=timer',
              '--no-legend', '--no-pager'], 'system', 'enabled'),
            (['systemctl', 'list-units', '--type=service', '--type=timer', '--all',
              '--no-legend', '--no-pager'], 'system', 'active'),
        ]
        if os.environ.get('XDG_RUNTIME_DIR'):
            commands.extend([
                (['systemctl', '--user', 'list-unit-files', '--type=service',
                  '--type=timer', '--no-legend', '--no-pager'], 'user', 'enabled'),
                (['systemctl', '--user', 'list-units', '--type=service', '--all',
                  '--type=timer', '--no-legend', '--no-pager'], 'user', 'active'),
            ])
        for command, scope, state_kind in commands:
            try:
                result = subprocess.run(
                    command, check=False, capture_output=True, text=True,
                    timeout=10, shell=False)
                output = result.stdout[:MAX_COMMAND_BYTES]
                if result.returncode != 0 or len(result.stdout) > MAX_COMMAND_BYTES:
                    complete = False
                for line in output.splitlines():
                    tokens = line.split()
                    for index, token in enumerate(tokens):
                        if UNIT_NAME.fullmatch(token):
                            if state_kind == 'enabled':
                                if index + 1 < len(tokens) and tokens[index + 1] in {
                                    'enabled', 'enabled-runtime',
                                }:
                                    enabled.add((scope, token))
                            elif index + 2 < len(tokens) and tokens[index + 2] == 'active':
                                active.add((scope, token))
                            break
            except (OSError, subprocess.SubprocessError):
                complete = False
        return active, enabled, complete

    def systemd_details(self, units: Iterable[tuple[str, str]]) -> tuple[dict[str, dict], bool]:
        """Return only allowlisted effective unit properties in two bounded calls."""
        details: dict[str, dict] = {}
        complete = True
        for scope in ('system', 'user'):
            names = sorted({
                name for name, unit_scope in units
                if (
                    unit_scope == scope and UNIT_NAME.fullmatch(name) and
                    not name.endswith(('@.service', '@.timer'))
                )
            })[:MAX_SYSTEMD_FILES_PER_LOCATION]
            if not names or (scope == 'user' and not os.environ.get('XDG_RUNTIME_DIR')):
                continue
            command = ['systemctl']
            if scope == 'user':
                command.append('--user')
            command.extend([
                'show', *names, '--no-pager',
                '--property=Id,ActiveState,UnitFileState,ExecStart,FragmentPath',
            ])
            try:
                result = subprocess.run(
                    command, check=False, capture_output=True, text=True,
                    timeout=10, shell=False)
                output = result.stdout[:MAX_COMMAND_BYTES]
                if result.returncode != 0 or len(result.stdout) > MAX_COMMAND_BYTES:
                    complete = False
                for block in output.split('\n\n'):
                    properties = {}
                    for line in block.splitlines():
                        name, separator, value = line.partition('=')
                        if separator and name in {
                            'Id', 'ActiveState', 'UnitFileState', 'ExecStart',
                            'FragmentPath',
                        }:
                            properties[name] = value[:MAX_FILE_BYTES]
                    unit_name = properties.get('Id')
                    if unit_name and UNIT_NAME.fullmatch(unit_name):
                        details[f'{scope}:{unit_name}'] = properties
            except (OSError, subprocess.SubprocessError):
                complete = False
        return details, complete


class ConflictScanner:
    def __init__(
        self, adapter: HostConflictAdapter | None = None,
        *, now: Callable[[], datetime] | None = None,
    ) -> None:
        self.adapter = adapter or HostConflictAdapter()
        self.now = now

    @staticmethod
    def _command_evidence(text: str) -> list[str]:
        return [description for pattern, description in COMMAND_PATTERNS if pattern.search(text)]

    @staticmethod
    def _excluded(path: Path) -> bool:
        lowered = str(path).lower()
        return (
            path.name in EXCLUDED_UNITS or 'fedorausage' in lowered or
            path.name.startswith('tuned') or
            ('auto-powersaver' in path.name and path.suffix in {'.sh', '.py', '.md'})
        )

    def scan(self) -> dict:
        if hasattr(self.adapter, 'begin_scan'):
            self.adapter.begin_scan()
        active, enabled, systemd_complete = self.adapter.systemd_state()
        findings: dict[str, dict] = {}
        candidates = self.adapter.candidates()
        candidate_text: dict[Path, str] = {}
        for path, _candidate_type, _scope in candidates:
            if self._excluded(path):
                continue
            value = self.adapter.read_text(path)
            if value is not None:
                candidate_text[path] = value
        if hasattr(self.adapter, 'systemd_details'):
            unit_details, details_complete = self.adapter.systemd_details(
                (path.name, scope) for path, candidate_type, scope in candidates
                if candidate_type == 'systemd_unit')
            systemd_complete = systemd_complete and details_complete
            for path, candidate_type, scope in candidates:
                if candidate_type != 'systemd_unit':
                    continue
                properties = unit_details.get(f'{scope}:{path.name}', {})
                if properties.get('ActiveState') == 'active':
                    active.add((scope, path.name))
                if properties.get('UnitFileState') in {'enabled', 'enabled-runtime'}:
                    enabled.add((scope, path.name))
                if path in candidate_text and properties.get('ExecStart'):
                    candidate_text[path] += f"\n{properties['ExecStart']}"
        unit_text_by_name = {
            path.name: text for path, text in candidate_text.items()
            if path.suffix in {'.service', '.timer'}
        }

        def evidence_for(text: str) -> list[str]:
            evidence = self._command_evidence(text)
            if evidence:
                return evidence
            referenced_paths = re.findall(
                r'/(?:usr/local/(?:bin|sbin))/[A-Za-z0-9_.+-]+', text)
            for referenced in referenced_paths[:8]:
                referenced_evidence = self._command_evidence(
                    candidate_text.get(Path(referenced), ''))
                evidence.extend(
                    f'references script that {item}' for item in referenced_evidence)
            return evidence

        for path, candidate_type, scope in candidates:
            if self._excluded(path):
                continue
            text = candidate_text.get(path)
            if text is None:
                continue
            evidence = evidence_for(text)
            if not evidence and candidate_type == 'systemd_unit' and path.suffix == '.timer':
                evidence = [
                    f'activates service that {item}'
                    for item in evidence_for(
                        unit_text_by_name.get(f'{path.stem}.service', ''))
                ]
            known = KNOWN_UNITS.get(path.name)
            if not evidence and not known:
                continue
            is_active = (scope, path.name) in active
            is_enabled = (scope, path.name) in enabled
            if known:
                evidence.insert(0, known)
            high = bool(evidence and (is_active or is_enabled))
            confidence = 'high' if high else ('medium' if evidence else 'low')
            if is_active:
                risk = 'active_competitor'
            elif is_enabled:
                risk = 'scheduled_competitor' if path.suffix == '.timer' else 'enabled_competitor'
            elif known:
                risk = 'inactive_historical'
                confidence = 'low'
            else:
                risk = 'possible_controller'
            finding_type = {
                'systemd_unit': ('systemd_timer' if path.suffix == '.timer' else 'systemd_service'),
                'script': 'script', 'cron': 'cron', 'autostart': 'autostart',
            }[candidate_type]
            identifier = f'{scope}:{candidate_type}:{path.name}'
            findings[identifier] = {
                'id': identifier,
                'type': finding_type,
                'scope': scope,
                'name': path.name,
                'active': is_active,
                'enabled': is_enabled,
                'confidence': confidence,
                'risk': risk,
                'evidence': evidence[:6],
                'safe_inspection_commands': (
                    [f'systemctl {"--user " if scope == "user" else ""}status '
                     f'{path.name} --no-pager',
                     f'systemctl {"--user " if scope == "user" else ""}cat {path.name}']
                    if candidate_type == 'systemd_unit' and UNIT_NAME.fullmatch(path.name)
                    else []
                ),
            }
            if len(findings) >= MAX_FINDINGS:
                self.adapter.incomplete = True
                break

        values = sorted(
            findings.values(),
            key=lambda item: (
                {'high': 0, 'medium': 1, 'low': 2}[item['confidence']], item['id']))
        complete = systemd_complete and not self.adapter.incomplete
        if any(item['confidence'] == 'high' and item['active'] for item in values):
            status = 'high_risk'
        elif values:
            status = 'warning' if any(item['confidence'] != 'low' for item in values) else 'informational'
        elif not complete:
            status = 'scan_incomplete'
        else:
            status = 'clear'
        return {
            'status': status,
            'scan_timestamp': _timestamp(self.now),
            'scan_complete': complete,
            'potential_competing_controller_count': len(values),
            'potential_competing_controllers': values,
        }
