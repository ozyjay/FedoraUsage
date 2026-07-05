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
const WARNING_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 90;

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

function _formatBytes(bytes) {
    const gib = 1024 * 1024 * 1024;
    const mib = 1024 * 1024;

    if (bytes >= gib)
        return `${(bytes / gib).toFixed(1)} GiB`;

    return `${Math.round(bytes / mib)} MiB`;
}

const MemoryUsageIndicator = GObject.registerClass(
class MemoryUsageIndicator extends PanelMenu.Button {
    constructor() {
        super(0.0, 'Memory Usage Widget');

        this._timeoutId = 0;

        this._label = new St.Label({
            style_class: 'memory-usage-label',
            text: 'Mem --%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

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
        this._filesystemItem = new PopupMenu.PopupMenuItem('Filesystem: --', {
            reactive: false,
            can_focus: false,
        });

        this.menu.addMenuItem(this._ramItem);
        this.menu.addMenuItem(this._availableItem);
        this.menu.addMenuItem(this._swapItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._filesystemItem);

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
        let filesystemStats = null;

        try {
            stats = _readMeminfo();
        } catch (error) {
            console.error(`Memory Usage Widget: failed to read /proc/meminfo: ${error}`);
            this._label.text = 'Mem --%';
            this._setLevelClass('unknown');
            return;
        }

        try {
            filesystemStats = _readFilesystemUsage('/');
        } catch (error) {
            console.error(`Memory Usage Widget: failed to read filesystem usage: ${error}`);
        }

        this._label.text = `Mem ${stats.usedPercent}% FS ${filesystemStats?.usedPercent ?? '--'}%`;
        this._ramItem.label.text = `RAM: ${_formatKib(stats.used)} / ${_formatKib(stats.total)} (${stats.usedPercent}%)`;
        this._availableItem.label.text = `Available: ${_formatKib(stats.available)}`;

        if (stats.swapTotal > 0) {
            this._swapItem.label.text =
                `Swap: ${_formatKib(stats.swapUsed)} / ${_formatKib(stats.swapTotal)} (${stats.swapPercent}%)`;
        } else {
            this._swapItem.label.text = 'Swap: not configured';
        }

        if (filesystemStats) {
            this._filesystemItem.label.text =
                `Filesystem /: ${_formatBytes(filesystemStats.used)} / ${_formatBytes(filesystemStats.total)} ` +
                `(${filesystemStats.usedPercent}%)`;
        } else {
            this._filesystemItem.label.text = 'Filesystem /: unavailable';
        }

        const highestUsedPercent = Math.max(stats.usedPercent, filesystemStats?.usedPercent ?? 0);

        if (highestUsedPercent >= CRITICAL_THRESHOLD)
            this._setLevelClass('critical');
        else if (highestUsedPercent >= WARNING_THRESHOLD)
            this._setLevelClass('warning');
        else
            this._setLevelClass('normal');
    }

    _setLevelClass(level) {
        for (const name of ['normal', 'warning', 'critical', 'unknown'])
            this.remove_style_class_name(`memory-usage-${name}`);

        this.add_style_class_name(`memory-usage-${level}`);
    }
});

export default class MemoryUsageExtension extends Extension {
    enable() {
        this._indicator = new MemoryUsageIndicator();
        Main.panel.addToStatusArea('memory-usage-widget', this._indicator, 0, 'right');
    }

    disable() {
        if (!this._indicator)
            return;

        Main.panel.menuManager.removeMenu(this._indicator.menu);
        this._indicator.destroy();
        this._indicator = null;
    }
}
