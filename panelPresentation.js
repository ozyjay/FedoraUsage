// SPDX-License-Identifier: GPL-3.0-or-later

export const PANEL_FIELD_ORDER = Object.freeze([
    'fan',
    'memory',
    'system-filesystem',
    'secondary-ssd',
    'auto-powersaver',
    'temperature',
]);

export const PANEL_MENU_READING_ORDER = Object.freeze([
    'fan',
    'memory',
    'system-filesystem',
    'secondary-ssd',
    'temperature',
]);

export const PANEL_TEMPERATURE_NORMAL_LABEL = '🌡';
export const PANEL_TEMPERATURE_HIGH_LABEL = '🔥';

export function formatPanelPercent(percent) {
    return percent === null ? '--%' : `${percent}%`;
}

export function formatTemperature(temperature) {
    return `${Math.round(temperature)}°C`;
}

export function formatFanSpeed(speed) {
    return `${speed} RPM`;
}

export function formatPanelTemperature(sensor) {
    return `${sensor.friendlyIcon} ${formatTemperature(sensor.temperature)}`;
}

export function temperaturePanelIcon(temperature, warningThresholdC) {
    return temperature >= warningThresholdC
        ? PANEL_TEMPERATURE_HIGH_LABEL
        : PANEL_TEMPERATURE_NORMAL_LABEL;
}

export function shouldShowFan(fanOne, enabled) {
    return enabled && fanOne !== null && fanOne.speed > 0;
}

export function panelLevel(
    memoryPercent,
    storageStats,
    hottestTemperature,
    warningThreshold,
    criticalThreshold,
    temperatureWarningThresholdC,
    temperatureCriticalThresholdC
) {
    const mountedStoragePercents = storageStats
        .filter(storage => storage.mounted)
        .map(storage => storage.usedPercent);
    const highestUsedPercent = Math.max(memoryPercent, ...mountedStoragePercents);

    if (highestUsedPercent >= criticalThreshold ||
        hottestTemperature >= temperatureCriticalThresholdC)
        return 'critical';

    if (highestUsedPercent >= warningThreshold ||
        hottestTemperature >= temperatureWarningThresholdC)
        return 'warning';

    return 'normal';
}

export function autoPowersaverPanelPresentation(status) {
    const unhealthy = status.service_health !== 'healthy' ||
        status.telemetry_quality !== 'healthy';
    const icon = unhealthy
        ? '!'
        : {
            disabled: '○',
            paused: 'Ⅱ',
            manual_override: 'M',
            automatic: status.active_profile === 'powersave' ? '↓' : 'A',
        }[status.policy_mode] ?? '!';

    let visualState = 'normal';
    if (status.service_health !== 'healthy' || status.telemetry_quality === 'unknown')
        visualState = 'fault';
    else if (status.thermal_state === 'hot')
        visualState = 'hot';
    else if (status.telemetry_quality === 'degraded')
        visualState = 'degraded';
    else if (!status.enabled)
        visualState = 'disabled';

    return {
        icon,
        temperatureText: status.control_temperature_c === null
            ? '--°C'
            : formatTemperature(status.control_temperature_c),
        visualState,
    };
}
