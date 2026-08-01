// SPDX-License-Identifier: GPL-3.0-or-later

import {
    autoPowersaverPanelPresentation,
    formatFanSpeed,
    formatPanelPercent,
    formatPanelTemperature,
    formatTemperature,
    panelLevel,
    PANEL_FIELD_ORDER,
    PANEL_MENU_READING_ORDER,
    shouldShowFan,
    temperaturePanelIcon,
} from '../panelPresentation.js';

let assertionCount = 0;

function assertEqual(actual, expected, description) {
    assertionCount++;
    if (actual !== expected) {
        throw new Error(
            `${description}: expected ${JSON.stringify(expected)}, ` +
            `received ${JSON.stringify(actual)}`);
    }
}

function assertArrayEqual(actual, expected, description) {
    assertEqual(JSON.stringify(actual), JSON.stringify(expected), description);
}

assertArrayEqual(PANEL_FIELD_ORDER, [
    'fan',
    'memory',
    'system-filesystem',
    'secondary-ssd',
    'auto-powersaver',
    'temperature',
], 'top-bar field order');
assertArrayEqual(PANEL_MENU_READING_ORDER, [
    'fan',
    'memory',
    'system-filesystem',
    'secondary-ssd',
    'temperature',
], 'popup reading order');

for (const [percent, expected] of [
    [null, '--%'],
    [0, '0%'],
    [4, '4%'],
    [9, '9%'],
    [10, '10%'],
    [99, '99%'],
    [100, '100%'],
])
    assertEqual(formatPanelPercent(percent), expected, `percentage ${percent}`);

for (const [speed, expected] of [
    [1, '1 RPM'],
    [711, '711 RPM'],
    [9999, '9999 RPM'],
    [12000, '12000 RPM'],
])
    assertEqual(formatFanSpeed(speed), expected, `fan speed ${speed}`);

assertEqual(shouldShowFan(null, true), false, 'missing fan is hidden');
assertEqual(shouldShowFan({speed: 0}, true), false, 'stopped fan is hidden');
assertEqual(shouldShowFan({speed: 711}, false), false, 'disabled fan is hidden');
assertEqual(shouldShowFan({speed: 711}, true), true, 'active enabled fan is shown');

for (const [temperature, expected] of [
    [-50, '-50°C'],
    [0, '0°C'],
    [9.4, '9°C'],
    [44.5, '45°C'],
    [99, '99°C'],
    [100, '100°C'],
    [150, '150°C'],
])
    assertEqual(formatTemperature(temperature), expected, `temperature ${temperature}`);

for (const icon of ['🎮', '🧠', '💾', '📶', '🌐', '🧱', '🧩', '🔌', '🌡']) {
    assertEqual(
        formatPanelTemperature({friendlyIcon: icon, temperature: 55}),
        `${icon} 55°C`,
        `hottest sensor icon ${icon}`);
}

assertEqual(temperaturePanelIcon(74.9, 75), '🌡', 'temperature below warning');
assertEqual(temperaturePanelIcon(75, 75), '🔥', 'temperature at warning');
assertEqual(temperaturePanelIcon(150, 75), '🔥', 'maximum temperature');

const mounted = usedPercent => ({mounted: true, usedPercent});
const missing = {mounted: false, usedPercent: 100};
for (const scenario of [
    {memory: 0, storage: [], temperature: 0, expected: 'normal'},
    {memory: 69, storage: [mounted(69)], temperature: 74.9, expected: 'normal'},
    {memory: 70, storage: [], temperature: 0, expected: 'warning'},
    {memory: 0, storage: [mounted(70)], temperature: 0, expected: 'warning'},
    {memory: 0, storage: [missing], temperature: 0, expected: 'normal'},
    {memory: 0, storage: [], temperature: 75, expected: 'warning'},
    {memory: 90, storage: [], temperature: 0, expected: 'critical'},
    {memory: 0, storage: [mounted(100)], temperature: 0, expected: 'critical'},
    {memory: 0, storage: [], temperature: 90, expected: 'critical'},
]) {
    assertEqual(panelLevel(
        scenario.memory,
        scenario.storage,
        scenario.temperature,
        70,
        90,
        75,
        90), scenario.expected, `panel level ${JSON.stringify(scenario)}`);
}

const healthyStatus = {
    active_profile: 'balanced',
    control_temperature_c: 44,
    enabled: true,
    policy_mode: 'automatic',
    service_health: 'healthy',
    telemetry_quality: 'healthy',
    thermal_state: 'normal',
};
for (const scenario of [
    {changes: {}, expected: {icon: 'A', temperatureText: '44°C', visualState: 'normal'}},
    {changes: {active_profile: 'powersave'}, expected: {icon: '↓', temperatureText: '44°C', visualState: 'normal'}},
    {changes: {policy_mode: 'paused'}, expected: {icon: 'Ⅱ', temperatureText: '44°C', visualState: 'normal'}},
    {changes: {policy_mode: 'manual_override'}, expected: {icon: 'M', temperatureText: '44°C', visualState: 'normal'}},
    {changes: {policy_mode: 'disabled', enabled: false}, expected: {icon: '○', temperatureText: '44°C', visualState: 'disabled'}},
    {changes: {thermal_state: 'hot'}, expected: {icon: 'A', temperatureText: '44°C', visualState: 'hot'}},
    {changes: {telemetry_quality: 'degraded'}, expected: {icon: '!', temperatureText: '44°C', visualState: 'degraded'}},
    {changes: {telemetry_quality: 'unknown'}, expected: {icon: '!', temperatureText: '44°C', visualState: 'fault'}},
    {changes: {service_health: 'fault'}, expected: {icon: '!', temperatureText: '44°C', visualState: 'fault'}},
    {changes: {control_temperature_c: null}, expected: {icon: 'A', temperatureText: '--°C', visualState: 'normal'}},
    {changes: {control_temperature_c: -50}, expected: {icon: 'A', temperatureText: '-50°C', visualState: 'normal'}},
    {changes: {control_temperature_c: 150}, expected: {icon: 'A', temperatureText: '150°C', visualState: 'normal'}},
]) {
    const actual = autoPowersaverPanelPresentation({
        ...healthyStatus,
        ...scenario.changes,
    });
    assertEqual(
        JSON.stringify(actual),
        JSON.stringify(scenario.expected),
        `Auto-Powersaver ${JSON.stringify(scenario.changes)}`);
}

print(`Panel presentation scenarios passed (${assertionCount} assertions).`);
