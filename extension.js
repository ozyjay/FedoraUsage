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
const PANEL_TEMPERATURE_LABEL = '🌡';
const WARNING_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 90;
const TEMPERATURE_WARNING_THRESHOLD_C = 75;
const TEMPERATURE_CRITICAL_THRESHOLD_C = 90;

function _workSsdPaths() {
    const userName = GLib.get_user_name();

    return [
        `/run/media/${userName}/Work`,
        `/media/${userName}/Work`,
        '/mnt/Work',
        '/mnt/work',
        '/media/Work',
        '/work',
    ];
}

const STORAGE_FILESYSTEMS = [
    {
        name: 'Fedora SSD',
        paths: ['/'],
    },
    {
        name: 'Work SSD',
        paths: _workSsdPaths(),
    },
];

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

function _readHwmonTemperatureSensors() {
    const sensors = [];

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

            sensors.push({
                name: label ? `${deviceName} ${label}` : deviceName,
                temperature,
            });
        }
    }

    return sensors;
}

function _readThermalZoneTemperatureSensors() {
    const sensors = [];

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

        sensors.push({
            name: type,
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
        console.error(`FedoraUsage: failed to read hwmon temperature sensors: ${error}`);
    }

    if (sensors.length === 0) {
        try {
            sensors = _readThermalZoneTemperatureSensors();
        } catch (error) {
            console.error(`FedoraUsage: failed to read thermal zone temperature sensors: ${error}`);
        }
    }

    sensors.sort((left, right) => right.temperature - left.temperature);

    return {
        available: sensors.length > 0,
        hottest: sensors[0] ?? null,
        sensors,
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

const FedoraUsageIndicator = GObject.registerClass(
class FedoraUsageIndicator extends PanelMenu.Button {
    constructor() {
        super(0.0, 'FedoraUsage');

        this._timeoutId = 0;

        this._panelBox = new St.BoxLayout({
            style_class: 'fedora-usage-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._memoryIconLabel = new St.Label({
            style_class: 'fedora-usage-label fedora-usage-icon',
            text: PANEL_MEMORY_LABEL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._memoryPercentLabel = new St.Label({
            style_class: 'fedora-usage-label fedora-usage-number mini-font',
            text: '--%',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelBox.add_child(this._memoryIconLabel);
        this._panelBox.add_child(this._memoryPercentLabel);

        this._temperatureIconLabel = new St.Label({
            style_class: 'fedora-usage-label fedora-usage-icon',
            text: PANEL_TEMPERATURE_LABEL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._temperatureLabel = new St.Label({
            style_class: 'fedora-usage-label fedora-usage-number mini-font',
            text: '--°C',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelBox.add_child(this._temperatureIconLabel);
        this._panelBox.add_child(this._temperatureLabel);

        this._storagePercentLabels = STORAGE_FILESYSTEMS.map(() => {
            const iconLabel = new St.Label({
                style_class: 'fedora-usage-label fedora-usage-icon',
                text: PANEL_FILESYSTEM_LABEL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const percentLabel = new St.Label({
                style_class: 'fedora-usage-label fedora-usage-number mini-font',
                text: '--%',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._panelBox.add_child(iconLabel);
            this._panelBox.add_child(percentLabel);

            return percentLabel;
        });

        this._ramItem = new PopupMenu.PopupMenuItem('RAM: --', {
            reactive: false,
            can_focus: false,
        });
        this._availableItem = new PopupMenu.PopupMenuItem('Available: --', {
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
        this._temperatureSensorItems = [];
        this._temperatureSensorSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._storageItems = STORAGE_FILESYSTEMS.map(storage =>
            new PopupMenu.PopupMenuItem(`${storage.name}: --`, {
                reactive: false,
                can_focus: false,
            }));

        this.menu.addMenuItem(this._ramItem);
        this.menu.addMenuItem(this._availableItem);
        this.menu.addMenuItem(this._swapItem);
        this.menu.addMenuItem(this._temperatureItem);
        this.menu.addMenuItem(this._temperatureSensorSeparator);
        for (const item of this._storageItems)
            this.menu.addMenuItem(item);

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
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }

        super.destroy();
    }

    _update() {
        let stats;
        let temperatureStats;
        let storageStats = [];

        try {
            stats = _readMeminfo();
        } catch (error) {
            console.error(`FedoraUsage: failed to read /proc/meminfo: ${error}`);
            this._memoryPercentLabel.text = '--%';
            this._temperatureLabel.text = '--°C';
            this._temperatureItem.label.text = 'Hottest: unavailable';
            this._setTemperatureSensorItems([]);
            for (const label of this._storagePercentLabels)
                label.text = '--%';
            this._setLevelClass('unknown');
            return;
        }

        temperatureStats = _readTemperatureStats();
        storageStats = STORAGE_FILESYSTEMS.map(storage => {
            const usage = _readStorageUsage(storage);

            if (usage.error)
                console.error(`FedoraUsage: failed to read ${storage.name} usage: ${usage.error}`);

            return usage;
        });

        this._memoryPercentLabel.text = `${stats.usedPercent}%`;
        this._ramItem.label.text = `RAM: ${_formatKib(stats.used)} / ${_formatKib(stats.total)} (${stats.usedPercent}%)`;
        this._availableItem.label.text = `Available: ${_formatKib(stats.available)}`;

        if (stats.swapTotal > 0) {
            this._swapItem.label.text =
                `Swap: ${_formatKib(stats.swapUsed)} / ${_formatKib(stats.swapTotal)} (${stats.swapPercent}%)`;
        } else {
            this._swapItem.label.text = 'Swap: not configured';
        }

        if (temperatureStats.available) {
            this._temperatureLabel.text = _formatTemperature(temperatureStats.hottest.temperature);
            this._temperatureItem.label.text =
                `Hottest: ${temperatureStats.hottest.name} ` +
                `${_formatTemperature(temperatureStats.hottest.temperature)}`;
        } else {
            this._temperatureLabel.text = '--°C';
            this._temperatureItem.label.text = 'Hottest: unavailable';
        }

        this._setTemperatureSensorItems(temperatureStats.sensors);

        storageStats.forEach((storage, index) => {
            if (storage.mounted) {
                this._storagePercentLabels[index].text = `${storage.usedPercent}%`;
                this._storageItems[index].label.text =
                    `${storage.name} (${storage.path}): ${_formatBytes(storage.used)} / ${_formatBytes(storage.total)} ` +
                    `(${storage.usedPercent}%)`;
            } else {
                this._storagePercentLabels[index].text = '--%';
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

    _setTemperatureSensorItems(sensors) {
        for (const item of this._temperatureSensorItems)
            item.destroy();

        this._temperatureSensorItems = sensors.map(sensor =>
            new PopupMenu.PopupMenuItem(
                `  ${sensor.name}: ${_formatTemperature(sensor.temperature)}`,
                {
                    reactive: false,
                    can_focus: false,
                }));

        this._temperatureSensorItems.forEach((item, index) =>
            this.menu.addMenuItem(item, 4 + index));
    }

    _setLevelClass(level) {
        for (const name of ['normal', 'warning', 'critical', 'unknown'])
            this.remove_style_class_name(`fedora-usage-${name}`);

        this.add_style_class_name(`fedora-usage-${level}`);
    }
});

export default class FedoraUsageExtension extends Extension {
    enable() {
        this._indicator = new FedoraUsageIndicator();
        Main.panel.addToStatusArea('FedoraUsage', this._indicator, 0, 'right');
    }

    disable() {
        if (!this._indicator)
            return;

        Main.panel.menuManager.removeMenu(this._indicator.menu);
        this._indicator.destroy();
        this._indicator = null;
    }
}
