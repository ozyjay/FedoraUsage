// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const UPDATE_INTERVAL_SECONDS = 2;
const PANEL_MEMORY_LABEL = '▦';
const PANEL_FILESYSTEM_LABEL = '🖴';
const PANEL_FAN_LABEL = '🌀';
const PANEL_TEMPERATURE_NORMAL_LABEL = '🌡';
const PANEL_TEMPERATURE_HIGH_LABEL = '🔥';
const WARNING_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 90;
const TEMPERATURE_WARNING_THRESHOLD_C = 75;
const TEMPERATURE_CRITICAL_THRESHOLD_C = 90;
const SENSOR_LOG_DIRECTORY_NAME = 'System Usage Logs';
const SENSOR_LOG_FILE_PATTERN = /^sensor-data-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SENSOR_HISTORY_ENABLED_KEY = 'sensor-history-enabled';
// Retain the original key name so existing day-based preferences migrate
// naturally when the unit setting is introduced.
const SENSOR_HISTORY_RETENTION_DAYS_KEY = 'sensor-history-retention-days';
const SENSOR_HISTORY_RETENTION_UNIT_KEY = 'sensor-history-retention-unit';
const SENSOR_HISTORY_CLEANUP_INTERVAL_SECONDS = 60;
const SHOW_MEMORY_KEY = 'show-memory-in-panel';
const SHOW_TEMPERATURE_KEY = 'show-temperature-in-panel';
const SHOW_FAN_KEY = 'show-fan-in-panel';
const SHOW_SYSTEM_FILESYSTEM_KEY = 'show-system-filesystem-in-panel';
const SHOW_WORK_FILESYSTEM_KEY = 'show-work-filesystem-in-panel';
const SECONDARY_SSD_LOCATION_KEY = 'secondary-ssd-location';
const SHOW_AUTO_POWERSAVER_KEY = 'show-auto-powersaver-in-panel';
const SHOW_AUTO_POWERSAVER_GPU_KEY = 'show-auto-powersaver-gpu-temperature';
const AUTO_POWERSAVER_NOTIFICATIONS_KEY = 'auto-powersaver-notifications-enabled';
const AUTO_POWERSAVER_BUS_NAME =
    'net.crunchycodes.FedoraUsage.AutoPowersaver1';
const AUTO_POWERSAVER_OBJECT_PATH =
    '/net/crunchycodes/FedoraUsage/AutoPowersaver1';
const AUTO_POWERSAVER_INTERFACE = AUTO_POWERSAVER_BUS_NAME;

const AUTO_POLICY_LABELS = {
    disabled: 'Disabled',
    automatic: 'Automatic',
    paused: 'Paused',
    manual_override: 'Manual override',
};

const AUTO_THERMAL_LABELS = {
    normal: 'Normal',
    hot: 'Hot',
    telemetry_degraded: 'Telemetry degraded',
    unknown: 'Unknown',
};

const AUTO_HEALTH_LABELS = {
    healthy: 'Healthy',
    service_unavailable: 'Service unavailable',
    tuned_unavailable: 'TuneD unavailable',
    fault: 'Fault',
};

const STORAGE_FILESYSTEMS = [
    {
        name: 'System filesystem',
        paths: ['/'],
        panelSettingKey: SHOW_SYSTEM_FILESYSTEM_KEY,
    },
    {
        name: 'Secondary SSD',
        panelSettingKey: SHOW_WORK_FILESYSTEM_KEY,
    },
];

function _storageFilesystems(settings) {
    return STORAGE_FILESYSTEMS.map(storage => storage.paths
        ? storage
        : {
            ...storage,
            paths: [settings.get_string(SECONDARY_SSD_LOCATION_KEY).trim()],
        });
}

function _readMeminfo() {
    const [, contents] = GLib.file_get_contents('/proc/meminfo');
    const decoder = new TextDecoder('utf-8');
    const meminfo = new Map();

    for (const line of decoder.decode(contents).split('\n')) {
        const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
        if (match)
            meminfo.set(match[1], Number.parseInt(match[2], 10));
    }

    const total = meminfo.get('MemTotal') ?? 0;
    const available = meminfo.get('MemAvailable') ?? 0;
    const used = Math.max(total - available, 0);
    const usedPercent = total > 0 ? Math.round(used / total * 100) : 0;

    const swapTotal = meminfo.get('SwapTotal') ?? 0;
    const swapFree = meminfo.get('SwapFree') ?? 0;
    const swapUsed = Math.max(swapTotal - swapFree, 0);
    const swapPercent = swapTotal > 0 ? Math.round(swapUsed / swapTotal * 100) : 0;

    return {
        total,
        available,
        used,
        usedPercent,
        swapTotal,
        swapUsed,
        swapPercent,
    };
}

function _formatKib(kib) {
    if (kib >= 1024 * 1024)
        return `${(kib / 1024 / 1024).toFixed(1)} GiB`;

    return `${Math.round(kib / 1024)} MiB`;
}

function _readTextFile(path) {
    const [, contents] = GLib.file_get_contents(path);
    const decoder = new TextDecoder('utf-8');

    return decoder.decode(contents).trim();
}

function _readOptionalTextFile(path) {
    try {
        return _readTextFile(path);
    } catch {
        return null;
    }
}

function _listDirectoryNames(path) {
    const directory = Gio.File.new_for_path(path);
    const enumerator = directory.enumerate_children(
        Gio.FILE_ATTRIBUTE_STANDARD_NAME,
        Gio.FileQueryInfoFlags.NONE,
        null);
    const names = [];

    try {
        let info;

        while ((info = enumerator.next_file(null)) !== null)
            names.push(info.get_name());
    } finally {
        enumerator.close(null);
    }

    return names;
}

function _setOwnerOnlyPermissions(file, mode) {
    file.set_attribute_uint32(
        Gio.FILE_ATTRIBUTE_UNIX_MODE,
        mode,
        Gio.FileQueryInfoFlags.NONE,
        null);
}

function _removeExpiredDailySensorLogs(directoryPath, now, retentionDays) {
    const oldestRetainedDate = now
        .add_days(-(retentionDays - 1))
        .format('%Y-%m-%d');

    for (const fileName of _listDirectoryNames(directoryPath)) {
        const match = fileName.match(SENSOR_LOG_FILE_PATTERN);

        if (!match || match[1] >= oldestRetainedDate)
            continue;

        Gio.File.new_for_path(`${directoryPath}/${fileName}`).delete(null);
    }
}

function _removeExpiredTimedSensorLogs(directoryPath, cutoff) {
    const cutoffDate = cutoff.format('%Y-%m-%d');
    const cutoffUnix = cutoff.to_unix();

    for (const fileName of _listDirectoryNames(directoryPath)) {
        const match = fileName.match(SENSOR_LOG_FILE_PATTERN);

        if (!match)
            continue;

        const file = Gio.File.new_for_path(`${directoryPath}/${fileName}`);

        if (match[1] < cutoffDate) {
            file.delete(null);
            continue;
        }

        if (match[1] > cutoffDate)
            continue;

        const [, contents] = file.load_contents(null);
        const decoder = new TextDecoder('utf-8');
        const retainedLines = [];

        for (const line of decoder.decode(contents).split('\n')) {
            if (!line)
                continue;

            try {
                const timestamp = JSON.parse(line).timestamp;
                const recordedAt = typeof timestamp === 'string'
                    ? GLib.DateTime.new_from_iso8601(timestamp, null)
                    : null;

                if (recordedAt === null || recordedAt.to_unix() >= cutoffUnix)
                    retainedLines.push(line);
            } catch {
                // Keep an unreadable record rather than risk deleting user data.
                retainedLines.push(line);
            }
        }

        if (retainedLines.length === 0) {
            file.delete(null);
            continue;
        }

        const encodedContents = new TextEncoder('utf-8')
            .encode(`${retainedLines.join('\n')}\n`);

        file.replace_contents(
            encodedContents,
            null,
            false,
            Gio.FileCreateFlags.PRIVATE,
            null);
        _setOwnerOnlyPermissions(file, 0o600);
    }
}

function _retentionCutoff(now, retentionLength, retentionUnit) {
    if (retentionUnit === 'minutes')
        return now.add_seconds(-retentionLength * 60);

    return now.add_seconds(-retentionLength * 60 * 60);
}

class SensorHistoryLogger {
    constructor() {
        this._directoryPath = GLib.build_filenamev([
            GLib.get_home_dir(),
            SENSOR_LOG_DIRECTORY_NAME,
        ]);
        this._lastCleanupSignature = null;
    }

    log(snapshot, retentionLength, retentionUnit) {
        const now = GLib.DateTime.new_now_local();
        const date = now.format('%Y-%m-%d');
        const cleanupPeriod = retentionUnit === 'days'
            ? date
            : Math.floor(now.to_unix() / SENSOR_HISTORY_CLEANUP_INTERVAL_SECONDS);
        const cleanupSignature =
            `${cleanupPeriod}:${retentionLength}:${retentionUnit}`;
        const directory = Gio.File.new_for_path(this._directoryPath);

        if (GLib.mkdir_with_parents(this._directoryPath, 0o700) !== 0)
            throw new Error(`could not create ${this._directoryPath}`);

        _setOwnerOnlyPermissions(directory, 0o700);

        const logFile = Gio.File.new_for_path(
            `${this._directoryPath}/sensor-data-${date}.jsonl`);
        const output = logFile.append_to(Gio.FileCreateFlags.PRIVATE, null);

        try {
            const record = {
                timestamp: now.format_iso8601(),
                ...snapshot,
            };
            const encodedRecord = new TextEncoder('utf-8')
                .encode(`${JSON.stringify(record)}\n`);

            output.write_all(encodedRecord, null);
        } finally {
            output.close(null);
        }

        _setOwnerOnlyPermissions(logFile, 0o600);

        if (this._lastCleanupSignature !== cleanupSignature) {
            try {
                if (retentionUnit === 'days') {
                    _removeExpiredDailySensorLogs(
                        this._directoryPath, now, retentionLength);
                } else {
                    _removeExpiredTimedSensorLogs(
                        this._directoryPath,
                        _retentionCutoff(now, retentionLength, retentionUnit));
                }
            } catch (error) {
                console.error(
                    `System Usage Monitor: failed to remove expired sensor history: ${error}`);
            }

            this._lastCleanupSignature = cleanupSignature;
        }
    }
}

function _parseMillidegreeTemperature(rawText) {
    const millidegrees = Number.parseInt(rawText, 10);
    const temperature = millidegrees / 1000;

    if (!Number.isFinite(temperature) || temperature < -50 || temperature > 150)
        return null;

    return temperature;
}

function _formatTemperature(temperature) {
    return `${Math.round(temperature)}°C`;
}

function _formatFanSpeed(speed) {
    return `${speed} RPM`;
}

function _friendlySensorInfo(rawName) {
    const normalisedName = rawName.toLowerCase();

    if (normalisedName.includes('amdgpu') || normalisedName.includes('gpu'))
        return {icon: '🎮', name: 'GPU'};

    if (normalisedName.includes('cpu_virtual'))
        return {icon: '🧠', name: 'CPU virtual'};

    if (normalisedName.includes('k10temp') ||
        normalisedName.includes('tctl') ||
        normalisedName.match(/\bcpu\b/) ||
        normalisedName.includes('cpu@'))
        return {icon: '🧠', name: 'CPU'};

    if (normalisedName.includes('nvme composite'))
        return {icon: '💾', name: 'SSD Composite'};

    if (normalisedName.match(/nvme sensor\s+\d+/)) {
        const sensorNumber = normalisedName.match(/sensor\s+(\d+)/)?.[1] ?? '';

        return {icon: '💾', name: `SSD Sensor ${sensorNumber}`.trim()};
    }

    if (normalisedName.includes('nvme'))
        return {icon: '💾', name: 'SSD'};

    if (normalisedName.includes('mt7925') ||
        normalisedName.includes('iwlwifi') ||
        normalisedName.includes('wifi') ||
        normalisedName.includes('wlan') ||
        normalisedName.includes('phy'))
        return {icon: '📶', name: 'Wi-Fi'};

    if (normalisedName.includes('r8169') ||
        normalisedName.includes('ethernet') ||
        normalisedName.includes(' lan'))
        return {icon: '🌐', name: 'Ethernet'};

    if (normalisedName.includes('mainboard_power'))
        return {icon: '🧱', name: 'Mainboard power'};

    if (normalisedName.includes('mainboard_memory'))
        return {icon: '🧩', name: 'Mainboard memory'};

    if (normalisedName.includes('mainboard_ambient'))
        return {icon: '🌡', name: 'Mainboard ambient'};

    if (normalisedName.includes('memory'))
        return {icon: '🧩', name: 'Memory'};

    if (normalisedName.includes('power'))
        return {icon: '🔌', name: 'Power'};

    if (normalisedName.includes('ambient'))
        return {icon: '🌡', name: 'Ambient'};

    if (normalisedName.includes('mainboard') || normalisedName.includes('cros_ec'))
        return {icon: '🧱', name: 'Mainboard'};

    if (normalisedName.includes('acpitz') || normalisedName.includes('thermal_zone'))
        return {icon: '🌡', name: 'ACPI/System'};

    return {
        icon: '🌡',
        name: rawName
            .replace(/_/g, ' ')
            .replace(/@[0-9a-f]+/gi, '')
            .replace(/\s+/g, ' ')
            .trim(),
    };
}

function _applyFriendlySensorNames(sensors) {
    const totals = new Map();
    const indexes = new Map();

    for (const sensor of sensors) {
        const friendly = _friendlySensorInfo(sensor.name);
        const key = `${friendly.icon} ${friendly.name}`;

        sensor.friendlyIcon = friendly.icon;
        sensor.friendlyName = friendly.name;
        sensor.friendlyKey = key;
        totals.set(key, (totals.get(key) ?? 0) + 1);
    }

    for (const sensor of sensors) {
        const count = (indexes.get(sensor.friendlyKey) ?? 0) + 1;
        const hasDuplicates = (totals.get(sensor.friendlyKey) ?? 0) > 1;
        const suffix = hasDuplicates ? ` ${count}` : '';

        indexes.set(sensor.friendlyKey, count);
        sensor.displayName = `${sensor.friendlyIcon} ${sensor.friendlyName}${suffix}`;
        sensor.panelName = `${sensor.friendlyName}${suffix}`;
    }

    return sensors;
}

function _formatPanelSensorName(name) {
    const maxLength = 14;

    if (name.length <= maxLength)
        return name;

    return `${name.slice(0, maxLength - 1)}…`;
}

function _formatPanelTemperature(sensor) {
    return `${_formatPanelSensorName(sensor.panelName)} ${_formatTemperature(sensor.temperature)}`;
}

function _readHwmonTemperatureSensors() {
    const sensors = [];
    const sourcePaths = new Set();

    for (const directoryName of _listDirectoryNames('/sys/class/hwmon')) {
        if (!directoryName.startsWith('hwmon'))
            continue;

        const basePath = `/sys/class/hwmon/${directoryName}`;
        const deviceName = _readOptionalTextFile(`${basePath}/name`) ?? directoryName;

        for (const fileName of _listDirectoryNames(basePath)) {
            const match = fileName.match(/^temp(\d+)_input$/);

            if (!match)
                continue;

            const rawTemperature = _readOptionalTextFile(`${basePath}/${fileName}`);
            const temperature = rawTemperature === null
                ? null
                : _parseMillidegreeTemperature(rawTemperature);

            if (temperature === null)
                continue;

            const label = _readOptionalTextFile(`${basePath}/temp${match[1]}_label`);
            const sourcePath = `${basePath}/${fileName}`;

            if (sourcePaths.has(sourcePath))
                continue;

            sourcePaths.add(sourcePath);

            sensors.push({
                name: label ? `${deviceName} ${label}` : deviceName,
                source: 'hwmon',
                sourcePath,
                device: deviceName,
                index: Number.parseInt(match[1], 10),
                label,
                temperature,
            });
        }
    }

    return sensors;
}

function _readThermalZoneTemperatureSensors() {
    const sensors = [];
    const sourcePaths = new Set();

    for (const directoryName of _listDirectoryNames('/sys/class/thermal')) {
        if (!directoryName.startsWith('thermal_zone'))
            continue;

        const basePath = `/sys/class/thermal/${directoryName}`;
        const type = _readOptionalTextFile(`${basePath}/type`) ?? directoryName;
        const rawTemperature = _readOptionalTextFile(`${basePath}/temp`);
        const temperature = rawTemperature === null
            ? null
            : _parseMillidegreeTemperature(rawTemperature);

        if (temperature === null)
            continue;

        const sourcePath = `${basePath}/temp`;

        if (sourcePaths.has(sourcePath))
            continue;

        sourcePaths.add(sourcePath);

        sensors.push({
            name: type,
            source: 'thermal_zone',
            sourcePath,
            device: type,
            index: Number.parseInt(directoryName.replace('thermal_zone', ''), 10),
            label: type,
            temperature,
        });
    }

    return sensors;
}

function _readTemperatureStats() {
    let sensors = [];

    try {
        sensors = _readHwmonTemperatureSensors();
    } catch (error) {
        console.error(`System Usage Monitor: failed to read hwmon temperature sensors: ${error}`);
    }

    if (sensors.length === 0) {
        try {
            sensors = _readThermalZoneTemperatureSensors();
        } catch (error) {
            console.error(`System Usage Monitor: failed to read thermal zone temperature sensors: ${error}`);
        }
    }

    sensors.sort((left, right) => right.temperature - left.temperature);
    sensors = _applyFriendlySensorNames(sensors);

    return {
        available: sensors.length > 0,
        hottest: sensors[0] ?? null,
        sensors,
    };
}

function _readFanStats() {
    const fans = [];
    const sourcePaths = new Set();

    try {
        for (const directoryName of _listDirectoryNames('/sys/class/hwmon')) {
            if (!directoryName.startsWith('hwmon'))
                continue;

            const basePath = `/sys/class/hwmon/${directoryName}`;
            const deviceName = _readOptionalTextFile(`${basePath}/name`) ?? directoryName;

            for (const fileName of _listDirectoryNames(basePath)) {
                const match = fileName.match(/^fan(\d+)_input$/);

                if (!match)
                    continue;

                const speed = Number.parseInt(
                    _readOptionalTextFile(`${basePath}/${fileName}`) ?? '', 10);

                if (!Number.isFinite(speed) || speed < 0)
                    continue;

                const number = Number.parseInt(match[1], 10);
                const label = _readOptionalTextFile(`${basePath}/fan${number}_label`);
                const sourcePath = `${basePath}/${fileName}`;

                if (sourcePaths.has(sourcePath))
                    continue;

                sourcePaths.add(sourcePath);

                fans.push({
                    source: 'hwmon',
                    sourcePath,
                    device: deviceName,
                    number,
                    name: label || `Fan ${number}`,
                    label,
                    speed,
                });
            }
        }
    } catch (error) {
        console.error(`System Usage Monitor: failed to read hwmon fan sensors: ${error}`);
    }

    fans.sort((left, right) =>
        left.number - right.number || left.device.localeCompare(right.device));

    // Stopped fans are recorded in history but remain hidden from the panel and menu.
    const activeFans = fans.filter(fan => fan.speed > 0);

    const fanOne = activeFans.find(fan => fan.number === 1) ?? null;

    return {
        fanOne,
        otherFans: activeFans.filter(fan => fan !== fanOne),
        allFans: fans,
    };
}

function _buildSensorSnapshot(memoryStats, temperatureStats, fanStats, storageStats) {
    return {
        schemaVersion: 1,
        memory: {
            totalKib: memoryStats.total,
            availableKib: memoryStats.available,
            usedKib: memoryStats.used,
            usedPercent: memoryStats.usedPercent,
        },
        swap: {
            totalKib: memoryStats.swapTotal,
            usedKib: memoryStats.swapUsed,
            usedPercent: memoryStats.swapPercent,
        },
        filesystems: storageStats.map(storage => storage.mounted
            ? {
                name: storage.name,
                path: storage.path,
                mounted: true,
                totalBytes: storage.total,
                freeBytes: storage.free,
                usedBytes: storage.used,
                usedPercent: storage.usedPercent,
            }
            : {
                name: storage.name,
                paths: storage.paths,
                mounted: false,
            }),
        temperatures: temperatureStats.sensors.map(sensor => ({
            source: sensor.source,
            sourcePath: sensor.sourcePath,
            device: sensor.device,
            index: sensor.index,
            label: sensor.label,
            name: sensor.displayName,
            temperatureC: sensor.temperature,
        })),
        fans: fanStats.allFans.map(fan => ({
            source: fan.source,
            sourcePath: fan.sourcePath,
            device: fan.device,
            index: fan.number,
            label: fan.label,
            name: fan.name,
            speedRpm: fan.speed,
        })),
    };
}

function _readFilesystemUsage(path = '/') {
    const file = Gio.File.new_for_path(path);
    const info = file.query_filesystem_info(
        [
            Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE,
            Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE,
        ].join(','),
        null);

    const total = info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE);
    const free = info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE);
    const used = Math.max(total - free, 0);
    const usedPercent = total > 0 ? Math.round(used / total * 100) : 0;

    return {
        path,
        total,
        free,
        used,
        usedPercent,
    };
}

function _readStorageUsage(storage) {
    let lastError = null;

    for (const path of storage.paths) {
        if (!GLib.file_test(path, GLib.FileTest.IS_DIR))
            continue;

        try {
            return {
                ..._readFilesystemUsage(path),
                name: storage.name,
                mounted: true,
            };
        } catch (error) {
            lastError = error;
        }
    }

    return {
        name: storage.name,
        paths: storage.paths,
        mounted: false,
        error: lastError,
    };
}

function _formatBytes(bytes) {
    const gib = 1024 * 1024 * 1024;
    const mib = 1024 * 1024;

    if (bytes >= gib)
        return `${(bytes / gib).toFixed(1)} GiB`;

    return `${Math.round(bytes / mib)} MiB`;
}

const SystemUsageIndicator = GObject.registerClass(
class SystemUsageIndicator extends PanelMenu.Button {
    constructor(settings, openPreferences) {
        super(0.0, 'System Usage Monitor');

        this._timeoutId = 0;
        this._settings = settings;
        this._settingsSignalIds = [];
        this._openPreferences = openPreferences;
        this._historyLogger = new SensorHistoryLogger();
        this._autoPowersaverProxy = null;
        this._autoPowersaverProxySignalId = 0;
        this._autoPowersaverCancellable = new Gio.Cancellable();
        this._autoPowersaverStatus = null;
        this._updatingAutoPowersaverSwitch = false;
        this._lastAutoPowersaverNotificationAt = 0;

        // PanelMenu.Button handles pointer input through this gesture, before
        // legacy button events reach the actor.
        this._clickGesture.connect('recognize', () => {
            if (this._clickGesture.get_button() !== Clutter.BUTTON_SECONDARY)
                return;

            this.menu.close();
            this._openPreferences();
        });

        this._panelBox = new St.BoxLayout({
            style_class: 'system-usage-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._memoryIconLabel = new St.Label({
            style_class: 'system-usage-label system-usage-icon',
            text: PANEL_MEMORY_LABEL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._memoryPercentLabel = new St.Label({
            style_class: 'system-usage-label system-usage-number mini-font',
            text: '--%',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelBox.add_child(this._memoryIconLabel);
        this._panelBox.add_child(this._memoryPercentLabel);

        this._temperatureIconLabel = new St.Label({
            style_class: 'system-usage-label system-usage-icon',
            text: PANEL_TEMPERATURE_NORMAL_LABEL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._temperatureLabel = new St.Label({
            style_class: 'system-usage-label system-usage-number mini-font',
            text: '--°C',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelBox.add_child(this._temperatureIconLabel);
        this._panelBox.add_child(this._temperatureLabel);

        this._autoPowersaverIconLabel = new St.Label({
            style_class: 'system-usage-label system-usage-icon',
            text: '!',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._autoPowersaverTemperatureLabel = new St.Label({
            style_class: 'system-usage-label system-usage-number mini-font',
            text: '--°C',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._autoPowersaverIconLabel);
        this._panelBox.add_child(this._autoPowersaverTemperatureLabel);

        this._fanIconLabel = new St.Label({
            style_class: 'system-usage-label system-usage-icon',
            text: PANEL_FAN_LABEL,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._fanSpeedLabel = new St.Label({
            style_class: 'system-usage-label system-usage-number mini-font',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._panelBox.add_child(this._fanIconLabel);
        this._panelBox.add_child(this._fanSpeedLabel);

        this._storagePanelLabels = STORAGE_FILESYSTEMS.map(() => {
            const iconLabel = new St.Label({
                style_class: 'system-usage-label system-usage-icon',
                text: PANEL_FILESYSTEM_LABEL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const percentLabel = new St.Label({
                style_class: 'system-usage-label system-usage-number mini-font',
                text: '--%',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._panelBox.add_child(iconLabel);
            this._panelBox.add_child(percentLabel);

            return {iconLabel, percentLabel};
        });

        this._ramItem = new PopupMenu.PopupMenuItem('RAM: --', {
            reactive: false,
            can_focus: false,
        });
        this._swapItem = new PopupMenu.PopupMenuItem('Swap: --', {
            reactive: false,
            can_focus: false,
        });
        this._temperatureItem = new PopupMenu.PopupMenuItem('Hottest: --', {
            reactive: false,
            can_focus: false,
        });
        this._temperatureSensorsSubMenu =
            new PopupMenu.PopupSubMenuMenuItem('Other temperature sensors');
        this._temperatureSensorItems = [];
        this._temperatureSensorSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._fanItem = new PopupMenu.PopupMenuItem('Fan 1: --', {
            reactive: false,
            can_focus: false,
        });
        this._fanItem.visible = false;
        this._otherFansSubMenu = new PopupMenu.PopupSubMenuMenuItem('Other fans');
        this._otherFansSubMenu.visible = false;
        this._otherFanItems = [];
        this._storageItems = STORAGE_FILESYSTEMS.map(storage =>
            new PopupMenu.PopupMenuItem(`${storage.name}: --`, {
                reactive: false,
                can_focus: false,
            }));

        this.menu.addMenuItem(this._ramItem);
        this.menu.addMenuItem(this._swapItem);
        this.menu.addMenuItem(this._temperatureItem);
        this.menu.addMenuItem(this._temperatureSensorsSubMenu);
        this.menu.addMenuItem(this._temperatureSensorSeparator);
        this.menu.addMenuItem(this._fanItem);
        this.menu.addMenuItem(this._otherFansSubMenu);
        for (const item of this._storageItems)
            this.menu.addMenuItem(item);

        this._autoPowersaverSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._autoPowersaverSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Auto-Powersaver', false);
        this._autoPowersaverModeItem = this._createStatusItem('Mode');
        this._autoPowersaverThermalItem = this._createStatusItem('Thermal state');
        this._autoPowersaverHealthItem = this._createStatusItem('Service health');
        this._autoPowersaverControlTemperatureItem =
            this._createStatusItem('Control temperature');
        this._autoPowersaverProfileItem = this._createStatusItem('TuneD profile');
        this._autoPowersaverTctlItem = this._createStatusItem('Tctl');
        this._autoPowersaverEcItem = this._createStatusItem('EC CPU');
        this._autoPowersaverGpuItem = this._createStatusItem('GPU edge');
        this._autoPowersaverThresholdsItem = this._createStatusItem('Thresholds');
        this._autoPowersaverReasonItem = this._createStatusItem('Reason');
        this._autoPowersaverPause15Item =
            new PopupMenu.PopupMenuItem('Pause for 15 minutes');
        this._autoPowersaverPause60Item =
            new PopupMenu.PopupMenuItem('Pause for 1 hour');
        this._autoPowersaverResumeItem =
            new PopupMenu.PopupMenuItem('Resume');
        this._autoPowersaverForceSaverItem =
            new PopupMenu.PopupMenuItem('Force Power Saver');
        this._autoPowersaverForceBalancedItem =
            new PopupMenu.PopupMenuItem('Force Balanced');
        this._autoPowersaverAutomaticItem =
            new PopupMenu.PopupMenuItem('Return to Automatic');
        this._autoPowersaverDisableBalancedItem =
            new PopupMenu.PopupMenuItem('Disable and switch to Balanced');
        this._autoPowersaverHistorySubMenu =
            new PopupMenu.PopupSubMenuMenuItem('Recent activity');
        this._autoPowersaverHistoryItems = [];
        this._autoPowersaverInfoItem = new PopupMenu.PopupMenuItem(
            'Changes the Fedora system-wide TuneD profile.', {
                reactive: false,
                can_focus: false,
            });
        this._autoPowersaverSettingsItem =
            new PopupMenu.PopupMenuItem('Auto-Powersaver settings…');

        for (const item of [
            this._autoPowersaverSeparator,
            this._autoPowersaverSwitch,
            this._autoPowersaverModeItem,
            this._autoPowersaverThermalItem,
            this._autoPowersaverHealthItem,
            this._autoPowersaverControlTemperatureItem,
            this._autoPowersaverProfileItem,
            this._autoPowersaverTctlItem,
            this._autoPowersaverEcItem,
            this._autoPowersaverGpuItem,
            this._autoPowersaverThresholdsItem,
            this._autoPowersaverReasonItem,
            new PopupMenu.PopupSeparatorMenuItem(),
            this._autoPowersaverPause15Item,
            this._autoPowersaverPause60Item,
            this._autoPowersaverResumeItem,
            this._autoPowersaverForceSaverItem,
            this._autoPowersaverForceBalancedItem,
            this._autoPowersaverAutomaticItem,
            this._autoPowersaverDisableBalancedItem,
            this._autoPowersaverHistorySubMenu,
            this._autoPowersaverSettingsItem,
            this._autoPowersaverInfoItem,
        ])
            this.menu.addMenuItem(item);

        this._autoPowersaverSwitch.connect('toggled', (_item, state) => {
            if (this._updatingAutoPowersaverSwitch)
                return;
            this._callAutoPowersaver(
                state ? 'Enable' : 'Disable',
                state
                    ? null
                    : new GLib.Variant('(b)', [
                        this._autoPowersaverStatus?.disable_behavior === 'balanced' &&
                        !this._autoPowersaverStatus?.hot_latched &&
                        this._autoPowersaverStatus?.control_temperature_c !== null &&
                        this._autoPowersaverStatus?.telemetry_age_seconds <=
                            this._autoPowersaverStatus?.poll_interval_seconds * 2,
                    ]));
        });
        this._autoPowersaverPause15Item.connect(
            'activate', () => this._callAutoPowersaver(
                'Pause', new GLib.Variant('(u)', [15 * 60])));
        this._autoPowersaverPause60Item.connect(
            'activate', () => this._callAutoPowersaver(
                'Pause', new GLib.Variant('(u)', [60 * 60])));
        this._autoPowersaverResumeItem.connect(
            'activate', () => this._callAutoPowersaver('Resume'));
        this._autoPowersaverForceSaverItem.connect(
            'activate', () => this._callAutoPowersaver(
                'ForceProfile', new GLib.Variant('(s)', ['powersave'])));
        this._autoPowersaverForceBalancedItem.connect(
            'activate', () => this._callAutoPowersaver(
                'ForceProfile', new GLib.Variant('(s)', ['balanced'])));
        this._autoPowersaverAutomaticItem.connect(
            'activate', () => this._callAutoPowersaver('ReturnToAutomatic'));
        this._autoPowersaverDisableBalancedItem.connect(
            'activate', () => this._callAutoPowersaver(
                'Disable', new GLib.Variant('(b)', [true])));
        this._autoPowersaverSettingsItem.connect(
            'activate', () => this._openPreferences());
        this._autoPowersaverHistorySubMenu.menu.connect(
            'open-state-changed', (_menu, open) => {
                if (open)
                    this._refreshAutoPowersaverHistory();
            });

        for (const key of [
            SHOW_MEMORY_KEY,
            SHOW_TEMPERATURE_KEY,
            SHOW_FAN_KEY,
            SHOW_SYSTEM_FILESYSTEM_KEY,
            SHOW_WORK_FILESYSTEM_KEY,
            SHOW_AUTO_POWERSAVER_KEY,
            SHOW_AUTO_POWERSAVER_GPU_KEY,
        ]) {
            this._settingsSignalIds.push(this._settings.connect(
                `changed::${key}`,
                () => this._applyPanelVisibility()));
        }

        this._applyPanelVisibility();
        this._setAutoPowersaverUnavailable();
        this._connectAutoPowersaver();
        this._update();
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            UPDATE_INTERVAL_SECONDS,
            () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            });
    }

    destroy() {
        this._autoPowersaverCancellable.cancel();
        if (this._autoPowersaverProxy && this._autoPowersaverProxySignalId) {
            this._autoPowersaverProxy.disconnect(this._autoPowersaverProxySignalId);
            this._autoPowersaverProxySignalId = 0;
        }
        this._autoPowersaverProxy = null;
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }

        for (const signalId of this._settingsSignalIds)
            this._settings.disconnect(signalId);
        this._settingsSignalIds = [];

        super.destroy();
    }

    _applyPanelVisibility() {
        const showMemory = this._settings.get_boolean(SHOW_MEMORY_KEY);
        const showTemperature = this._settings.get_boolean(SHOW_TEMPERATURE_KEY);
        const showAutoPowersaver =
            this._settings.get_boolean(SHOW_AUTO_POWERSAVER_KEY);

        this._memoryIconLabel.visible = showMemory;
        this._memoryPercentLabel.visible = showMemory;
        this._temperatureIconLabel.visible = showTemperature;
        this._temperatureLabel.visible = showTemperature;
        this._autoPowersaverIconLabel.visible = showAutoPowersaver;
        this._autoPowersaverTemperatureLabel.visible = showAutoPowersaver;
        this._autoPowersaverGpuItem.visible =
            this._settings.get_boolean(SHOW_AUTO_POWERSAVER_GPU_KEY);

        const showFan = this._settings.get_boolean(SHOW_FAN_KEY) &&
            this._fanSpeedLabel.text !== '';
        this._fanIconLabel.visible = showFan;
        this._fanSpeedLabel.visible = showFan;

        this._storagePanelLabels.forEach((labels, index) => {
            const visible = this._settings.get_boolean(
                STORAGE_FILESYSTEMS[index].panelSettingKey);

            labels.iconLabel.visible = visible;
            labels.percentLabel.visible = visible;
        });
    }

    _createStatusItem(label) {
        return new PopupMenu.PopupMenuItem(`${label}: --`, {
            reactive: false,
            can_focus: false,
        });
    }

    _connectAutoPowersaver() {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            null,
            AUTO_POWERSAVER_BUS_NAME,
            AUTO_POWERSAVER_OBJECT_PATH,
            AUTO_POWERSAVER_INTERFACE,
            this._autoPowersaverCancellable,
            (_source, result) => {
                if (this._autoPowersaverCancellable.is_cancelled())
                    return;

                try {
                    this._autoPowersaverProxy =
                        Gio.DBusProxy.new_for_bus_finish(result);
                    this._autoPowersaverProxySignalId =
                        this._autoPowersaverProxy.connect(
                            'g-signal',
                            (_proxy, _sender, signalName, parameters) =>
                                this._handleAutoPowersaverSignal(signalName, parameters));
                    this._autoPowersaverProxy.connect(
                        'notify::g-name-owner', () => {
                            if (this._autoPowersaverProxy.get_name_owner())
                                this._loadAutoPowersaverStatus();
                            else
                                this._setAutoPowersaverUnavailable();
                        });
                    this._loadAutoPowersaverStatus();
                } catch (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        console.error(
                            `System Usage Monitor: failed to connect to Auto-Powersaver: ${error}`);
                    }
                    this._setAutoPowersaverUnavailable();
                }
            });
    }

    _loadAutoPowersaverStatus() {
        this._callAutoPowersaver('GetStatus', null, false);
    }

    _callAutoPowersaver(method, parameters = null, showError = true) {
        if (!this._autoPowersaverProxy) {
            if (showError)
                Main.notify('Auto-Powersaver', 'The system service is unavailable.');
            this._setAutoPowersaverUnavailable();
            return;
        }

        this._autoPowersaverProxy.call(
            method,
            parameters,
            Gio.DBusCallFlags.NONE,
            120000,
            this._autoPowersaverCancellable,
            (proxy, result) => {
                if (this._autoPowersaverCancellable.is_cancelled())
                    return;
                try {
                    const response = proxy.call_finish(result);
                    const [payload] = response.deepUnpack();
                    this._applyAutoPowersaverStatus(JSON.parse(payload));
                } catch (error) {
                    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    console.error(
                        `System Usage Monitor: Auto-Powersaver ${method} failed: ${error}`);
                    if (showError)
                        Main.notify('Auto-Powersaver request failed', error.message);
                    if (method === 'GetStatus')
                        this._setAutoPowersaverUnavailable();
                    else
                        this._loadAutoPowersaverStatus();
                }
            });
    }

    _handleAutoPowersaverSignal(signalName, parameters) {
        const [payload] = parameters.deepUnpack();
        try {
            if (signalName === 'StatusChanged') {
                this._applyAutoPowersaverStatus(JSON.parse(payload));
            } else if (signalName === 'TransitionRecorded') {
                const transition = JSON.parse(payload);

                this._refreshAutoPowersaverHistory();
                this._notifyAutoPowersaverTransition(transition);
            }
        } catch (error) {
            console.error(
                `System Usage Monitor: invalid Auto-Powersaver ${signalName} payload: ${error}`);
        }
    }

    _sensorTemperature(status, name) {
        const reading = status.sensor_readings?.[name];

        if (!reading?.valid || reading.temperature_c === null)
            return 'Unavailable';
        return _formatTemperature(reading.temperature_c);
    }

    _applyAutoPowersaverStatus(status) {
        this._autoPowersaverStatus = status;
        const mode = AUTO_POLICY_LABELS[status.policy_mode] ?? status.policy_mode;
        const thermal = AUTO_THERMAL_LABELS[status.thermal_state] ??
            status.thermal_state;
        const health = AUTO_HEALTH_LABELS[status.service_health] ??
            status.service_health;
        const controlTemperature = status.control_temperature_c === null
            ? 'Unavailable'
            : _formatTemperature(status.control_temperature_c);

        this._updatingAutoPowersaverSwitch = true;
        this._autoPowersaverSwitch.setToggleState(Boolean(status.enabled));
        this._updatingAutoPowersaverSwitch = false;
        this._autoPowersaverSwitch.setSensitive(true);
        this._autoPowersaverModeItem.label.text = `Mode: ${mode}`;
        this._autoPowersaverThermalItem.label.text = `Thermal state: ${thermal}`;
        this._autoPowersaverHealthItem.label.text = `Service health: ${health}`;
        this._autoPowersaverControlTemperatureItem.label.text =
            `Control temperature: ${controlTemperature}`;
        this._autoPowersaverProfileItem.label.text =
            `TuneD profile: ${status.active_profile ?? 'Unavailable'}`;
        this._autoPowersaverTctlItem.label.text =
            `Tctl: ${this._sensorTemperature(status, 'k10temp/Tctl')}`;
        this._autoPowersaverEcItem.label.text =
            `EC CPU: ${this._sensorTemperature(status, 'cros_ec/cpu@4c')}`;
        this._autoPowersaverGpuItem.label.text =
            `GPU edge: ${this._sensorTemperature(status, 'amdgpu/edge')}`;
        this._autoPowersaverThresholdsItem.label.text =
            `Thresholds: ${status.hot_threshold_c}°C hot / ` +
            `${status.recovery_threshold_c}°C recovery`;
        this._autoPowersaverReasonItem.label.text =
            `Reason: ${(status.effective_profile_reason ?? 'Unknown').replace(/_/g, ' ')}`;

        const icon = status.service_health !== 'healthy' ||
            status.telemetry_quality !== 'healthy'
            ? '!'
            : {
                disabled: '○',
                paused: 'Ⅱ',
                manual_override: 'M',
                automatic: status.active_profile === 'powersave' ? '↓' : 'A',
            }[status.policy_mode] ?? '!';
        this._autoPowersaverIconLabel.text = icon;
        this._autoPowersaverTemperatureLabel.text = status.control_temperature_c === null
            ? '--°C'
            : _formatTemperature(status.control_temperature_c);
        let autoVisualState = 'normal';

        if (status.service_health !== 'healthy' || status.telemetry_quality === 'unknown')
            autoVisualState = 'fault';
        else if (status.thermal_state === 'hot')
            autoVisualState = 'hot';
        else if (status.telemetry_quality === 'degraded')
            autoVisualState = 'degraded';
        else if (!status.enabled)
            autoVisualState = 'disabled';
        this._setAutoPowersaverVisualState(autoVisualState);

        const enabled = Boolean(status.enabled);
        const canSelectBalanced = enabled && !status.hot_latched &&
            status.control_temperature_c !== null && status.tuned_available &&
            status.telemetry_age_seconds <= status.poll_interval_seconds * 2;
        const canMutateProfile = enabled && status.tuned_available;

        this._autoPowersaverPause15Item.setSensitive(enabled);
        this._autoPowersaverPause60Item.setSensitive(enabled);
        this._autoPowersaverResumeItem.setSensitive(
            enabled && status.policy_mode === 'paused');
        this._autoPowersaverForceSaverItem.setSensitive(canMutateProfile);
        this._autoPowersaverForceBalancedItem.setSensitive(canSelectBalanced);
        this._autoPowersaverAutomaticItem.setSensitive(
            enabled && status.policy_mode !== 'automatic');
        this._autoPowersaverDisableBalancedItem.setSensitive(canSelectBalanced);

        if (status.policy_mode === 'paused' && status.paused_seconds_remaining !== null) {
            const minutes = Math.max(1, Math.ceil(status.paused_seconds_remaining / 60));

            this._autoPowersaverModeItem.label.text =
                `Mode: Paused — ${minutes} min remaining`;
        } else if (
            status.policy_mode === 'manual_override' &&
            status.manual_override_seconds_remaining !== null
        ) {
            const minutes = Math.max(
                1, Math.ceil(status.manual_override_seconds_remaining / 60));

            this._autoPowersaverModeItem.label.text =
                `Mode: Manual override — ${minutes} min remaining`;
        }
    }

    _setAutoPowersaverUnavailable() {
        this._autoPowersaverStatus = null;
        this._autoPowersaverIconLabel.text = '!';
        this._autoPowersaverTemperatureLabel.text = '--°C';
        this._setAutoPowersaverVisualState('fault');
        this._updatingAutoPowersaverSwitch = true;
        this._autoPowersaverSwitch.setToggleState(false);
        this._updatingAutoPowersaverSwitch = false;
        this._autoPowersaverSwitch.setSensitive(false);
        this._autoPowersaverModeItem.label.text = 'Mode: Unavailable';
        this._autoPowersaverThermalItem.label.text = 'Thermal state: Unknown';
        this._autoPowersaverHealthItem.label.text =
            'Service health: Service unavailable';
        this._autoPowersaverControlTemperatureItem.label.text =
            'Control temperature: Unavailable';
        this._autoPowersaverProfileItem.label.text = 'TuneD profile: Unavailable';
        for (const item of [
            this._autoPowersaverPause15Item,
            this._autoPowersaverPause60Item,
            this._autoPowersaverResumeItem,
            this._autoPowersaverForceSaverItem,
            this._autoPowersaverForceBalancedItem,
            this._autoPowersaverAutomaticItem,
            this._autoPowersaverDisableBalancedItem,
        ])
            item.setSensitive(false);
    }

    _setAutoPowersaverVisualState(state) {
        for (const actor of [
            this._autoPowersaverIconLabel,
            this._autoPowersaverTemperatureLabel,
        ]) {
            for (const name of ['normal', 'hot', 'degraded', 'fault', 'disabled'])
                actor.remove_style_class_name(`system-usage-auto-${name}`);
            actor.add_style_class_name(`system-usage-auto-${state}`);
        }
    }

    _refreshAutoPowersaverHistory() {
        if (!this._autoPowersaverProxy)
            return;
        this._autoPowersaverProxy.call(
            'GetRecentTransitions',
            new GLib.Variant('(u)', [10]),
            Gio.DBusCallFlags.NONE,
            5000,
            this._autoPowersaverCancellable,
            (proxy, result) => {
                try {
                    const response = proxy.call_finish(result);
                    const [payload] = response.deepUnpack();
                    this._setAutoPowersaverHistoryItems(JSON.parse(payload));
                } catch (error) {
                    if (!this._autoPowersaverCancellable.is_cancelled()) {
                        console.error(
                            `System Usage Monitor: could not load Auto-Powersaver history: ${error}`);
                    }
                }
            });
    }

    _setAutoPowersaverHistoryItems(transitions) {
        for (const item of this._autoPowersaverHistoryItems)
            item.destroy();

        const recent = [...transitions].reverse();
        this._autoPowersaverHistoryItems = recent.length > 0
            ? recent.map(transition => {
                const timestamp = new Date(transition.timestamp);
                const time = Number.isNaN(timestamp.valueOf())
                    ? '--:--'
                    : timestamp.toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                const profileChange = transition.previous_profile &&
                    transition.resulting_profile
                    ? `${transition.previous_profile} → ${transition.resulting_profile}`
                    : transition.reason.replace(/_/g, ' ');
                const temperature = transition.control_temperature_c === null
                    ? ''
                    : ` ${_formatTemperature(transition.control_temperature_c)}`;

                return new PopupMenu.PopupMenuItem(
                    `${time}  ${profileChange}${temperature}`, {
                        reactive: false,
                        can_focus: false,
                    });
            })
            : [new PopupMenu.PopupMenuItem('No recent activity', {
                reactive: false,
                can_focus: false,
            })];
        this._autoPowersaverHistoryItems.forEach(item =>
            this._autoPowersaverHistorySubMenu.menu.addMenuItem(item));
    }

    _notifyAutoPowersaverTransition(transition) {
        if (!this._settings.get_boolean(AUTO_POWERSAVER_NOTIFICATIONS_KEY))
            return;
        if (!['safety', 'recovery', 'fault'].includes(transition.trigger_source))
            return;
        const now = GLib.get_monotonic_time();

        if (now - this._lastAutoPowersaverNotificationAt < 60 * 1000 * 1000)
            return;

        const temperature = transition.control_temperature_c === null
            ? ''
            : ` at ${transition.control_temperature_c.toFixed(1)}°C`;
        let message;

        if (!transition.success) {
            message = `A profile transition failed${temperature}.`;
        } else if (transition.resulting_profile === 'powersave') {
            message = `Power Saver was enabled${temperature}.`;
        } else if (transition.resulting_profile === 'balanced') {
            message = `Balanced was restored${temperature}.`;
        } else {
            return;
        }
        this._lastAutoPowersaverNotificationAt = now;
        Main.notify('Auto-Powersaver', message);
    }

    _update() {
        let stats;
        let temperatureStats;
        let fanStats;
        let storageStats = [];

        try {
            stats = _readMeminfo();
        } catch (error) {
            console.error(`System Usage Monitor: failed to read /proc/meminfo: ${error}`);
            this._memoryPercentLabel.text = '--%';
            this._temperatureIconLabel.text = PANEL_TEMPERATURE_NORMAL_LABEL;
            this._temperatureLabel.text = '--°C';
            this._temperatureItem.label.text = 'Hottest: unavailable';
            this._setTemperatureSensorItems([]);
            this._setFanItems({fanOne: null, otherFans: []});
            for (const labels of this._storagePanelLabels)
                labels.percentLabel.text = '--%';
            this._setLevelClass('unknown');
            return;
        }

        temperatureStats = _readTemperatureStats();
        fanStats = _readFanStats();
        storageStats = _storageFilesystems(this._settings).map(storage => {
            const usage = _readStorageUsage(storage);

            if (usage.error)
                console.error(`System Usage Monitor: failed to read ${storage.name} usage: ${usage.error}`);

            return usage;
        });

        if (this._settings.get_boolean(SENSOR_HISTORY_ENABLED_KEY)) {
            try {
                const retentionLength = Math.max(
                    this._settings.get_int(SENSOR_HISTORY_RETENTION_DAYS_KEY), 1);
                const retentionUnit =
                    this._settings.get_string(SENSOR_HISTORY_RETENTION_UNIT_KEY);

                this._historyLogger.log(
                    _buildSensorSnapshot(stats, temperatureStats, fanStats, storageStats),
                    retentionLength,
                    retentionUnit);
            } catch (error) {
                console.error(`System Usage Monitor: failed to write sensor history: ${error}`);
            }
        }

        this._memoryPercentLabel.text = `${stats.usedPercent}%`;
        this._ramItem.label.text = `RAM: ${_formatKib(stats.used)} / ${_formatKib(stats.total)} (${stats.usedPercent}%)`;

        if (stats.swapTotal > 0) {
            this._swapItem.label.text =
                `Swap: ${_formatKib(stats.swapUsed)} / ${_formatKib(stats.swapTotal)} (${stats.swapPercent}%)`;
        } else {
            this._swapItem.label.text = 'Swap: not configured';
        }

        if (temperatureStats.available) {
            this._temperatureIconLabel.text =
                temperatureStats.hottest.temperature >= TEMPERATURE_WARNING_THRESHOLD_C
                    ? PANEL_TEMPERATURE_HIGH_LABEL
                    : PANEL_TEMPERATURE_NORMAL_LABEL;
            this._temperatureLabel.text = _formatPanelTemperature(temperatureStats.hottest);
            this._temperatureItem.label.text =
                `Hottest: ${temperatureStats.hottest.displayName} ` +
                `${_formatTemperature(temperatureStats.hottest.temperature)}`;
        } else {
            this._temperatureIconLabel.text = PANEL_TEMPERATURE_NORMAL_LABEL;
            this._temperatureLabel.text = '--°C';
            this._temperatureItem.label.text = 'Hottest: unavailable';
        }

        this._setTemperatureSensorItems(temperatureStats.sensors, temperatureStats.hottest);
        this._setFanItems(fanStats);

        storageStats.forEach((storage, index) => {
            if (storage.mounted) {
                this._storagePanelLabels[index].percentLabel.text = `${storage.usedPercent}%`;
                this._storageItems[index].label.text =
                    `${storage.name} (${storage.path}): ${_formatBytes(storage.used)} / ${_formatBytes(storage.total)} ` +
                    `(${storage.usedPercent}%)`;
            } else {
                this._storagePanelLabels[index].percentLabel.text = '--%';
                this._storageItems[index].label.text =
                    `${storage.name}: not mounted`;
            }
        });

        let highestUsedPercent = stats.usedPercent;

        for (const storage of storageStats) {
            if (storage.mounted)
                highestUsedPercent = Math.max(highestUsedPercent, storage.usedPercent);
        }

        const hottestTemperature =
            temperatureStats.available ? temperatureStats.hottest.temperature : 0;

        if (highestUsedPercent >= CRITICAL_THRESHOLD ||
            hottestTemperature >= TEMPERATURE_CRITICAL_THRESHOLD_C)
            this._setLevelClass('critical');
        else if (highestUsedPercent >= WARNING_THRESHOLD ||
            hottestTemperature >= TEMPERATURE_WARNING_THRESHOLD_C)
            this._setLevelClass('warning');
        else
            this._setLevelClass('normal');
    }

    _setTemperatureSensorItems(sensors, hottestSensor = null) {
        for (const item of this._temperatureSensorItems)
            item.destroy();

        const otherSensors = hottestSensor === null
            ? sensors
            : sensors.filter(sensor => sensor !== hottestSensor);
        const sensorCount = otherSensors.length;

        this._temperatureSensorsSubMenu.label.text =
            `Other temperature sensors (${sensorCount})`;

        if (sensorCount === 0) {
            this._temperatureSensorItems = [
                new PopupMenu.PopupMenuItem('No other sensors found', {
                    reactive: false,
                    can_focus: false,
                }),
            ];
        } else {
            this._temperatureSensorItems = otherSensors.map(sensor =>
                new PopupMenu.PopupMenuItem(
                    `${sensor.displayName}: ${_formatTemperature(sensor.temperature)}`,
                    {
                        reactive: false,
                        can_focus: false,
                    }));
        }

        this._temperatureSensorItems.forEach(item =>
            this._temperatureSensorsSubMenu.menu.addMenuItem(item));
    }

    _setFanItems({fanOne, otherFans}) {
        const showFanOne = fanOne !== null;

        this._fanIconLabel.visible = showFanOne;
        this._fanSpeedLabel.visible = showFanOne;
        this._fanItem.visible = showFanOne;
        this._fanSpeedLabel.text = showFanOne ? _formatFanSpeed(fanOne.speed) : '';
        const showFanInPanel = showFanOne && this._settings.get_boolean(SHOW_FAN_KEY);

        this._fanIconLabel.visible = showFanInPanel;
        this._fanSpeedLabel.visible = showFanInPanel;

        if (showFanOne)
            this._fanItem.label.text = `${fanOne.name}: ${_formatFanSpeed(fanOne.speed)}`;

        for (const item of this._otherFanItems)
            item.destroy();

        this._otherFanItems = otherFans.map(fan =>
            new PopupMenu.PopupMenuItem(
                `${fan.name}: ${_formatFanSpeed(fan.speed)}`,
                {
                    reactive: false,
                    can_focus: false,
                }));

        this._otherFansSubMenu.visible = this._otherFanItems.length > 0;
        this._otherFansSubMenu.label.text = `Other fans (${this._otherFanItems.length})`;
        this._otherFanItems.forEach(item =>
            this._otherFansSubMenu.menu.addMenuItem(item));
    }

    _setLevelClass(level) {
        for (const name of ['normal', 'warning', 'critical', 'unknown'])
            this.remove_style_class_name(`system-usage-${name}`);

        this.add_style_class_name(`system-usage-${level}`);
    }
});

export default class SystemUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new SystemUsageIndicator(
            this._settings,
            () => this.openPreferences());
        Main.panel.addToStatusArea('system-usage', this._indicator, 0, 'right');
    }

    disable() {
        if (!this._indicator)
            return;

        Main.panel.menuManager.removeMenu(this._indicator.menu);
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
