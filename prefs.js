// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SENSOR_HISTORY_ENABLED_KEY = 'sensor-history-enabled';
const SENSOR_HISTORY_RETENTION_DAYS_KEY = 'sensor-history-retention-days';
const SENSOR_HISTORY_RETENTION_UNIT_KEY = 'sensor-history-retention-unit';
const SECONDARY_SSD_LOCATION_KEY = 'secondary-ssd-location';

const PANEL_ITEMS = [
    ['show-memory-in-panel', 'Memory', 'Show current memory use'],
    ['show-temperature-in-panel', 'Temperature', 'Show the hottest sensor reading'],
    ['show-fan-in-panel', 'Fan', 'Show Fan 1 while it is running'],
    ['show-system-filesystem-in-panel', 'System filesystem', 'Show usage for the filesystem mounted at /'],
    ['show-work-filesystem-in-panel', 'Secondary SSD', 'Show usage for the configured secondary SSD'],
];

const RETENTION_UNITS = ['minutes', 'hours', 'days'];
const RETENTION_UNIT_LABELS = ['Minutes', 'Hours', 'Days'];
const RETENTION_UNIT_MAXIMUMS = {
    minutes: 10080,
    hours: 8760,
    days: 365,
};

export default class SystemUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'System Usage Monitor',
            icon_name: 'utilities-system-monitor-symbolic',
        });
        const panelGroup = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'Choose which readings appear in the top bar.',
        });

        for (const [key, title, subtitle] of PANEL_ITEMS) {
            const row = new Adw.SwitchRow({title, subtitle});

            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            panelGroup.add(row);
        }

        const storageGroup = new Adw.PreferencesGroup({
            title: 'Storage',
            description: 'Set the mount location used for the secondary SSD reading.',
        });
        const secondarySsdLocationRow = new Adw.EntryRow({
            title: 'Secondary SSD location',
        });

        settings.bind(
            SECONDARY_SSD_LOCATION_KEY,
            secondarySsdLocationRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT);
        storageGroup.add(secondarySsdLocationRow);

        const group = new Adw.PreferencesGroup({
            title: 'Sensor history',
            description: 'Control whether recent system readings are written to disk.',
        });
        const historyRow = new Adw.SwitchRow({
            title: 'Record sensor history',
            subtitle: 'Write a system snapshot every two seconds',
        });
        const retentionAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: RETENTION_UNIT_MAXIMUMS.days,
            step_increment: 1,
            page_increment: 7,
            value: 7,
        });
        const retentionRow = new Adw.SpinRow({
            title: 'Retention length',
            subtitle: 'How long to keep local sensor records',
            adjustment: retentionAdjustment,
        });
        const retentionUnitRow = new Adw.ComboRow({
            title: 'Retention unit',
            model: Gtk.StringList.new(RETENTION_UNIT_LABELS),
        });
        const updateRetentionUnit = () => {
            const unit = settings.get_string(SENSOR_HISTORY_RETENTION_UNIT_KEY);
            const unitIndex = RETENTION_UNITS.indexOf(unit);

            retentionUnitRow.selected = unitIndex === -1 ? 2 : unitIndex;
            retentionAdjustment.upper = RETENTION_UNIT_MAXIMUMS[unit] ??
                RETENTION_UNIT_MAXIMUMS.days;
        };

        updateRetentionUnit();
        settings.bind(
            SENSOR_HISTORY_ENABLED_KEY,
            historyRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        settings.bind(
            SENSOR_HISTORY_RETENTION_DAYS_KEY,
            retentionRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT);
        retentionUnitRow.connect('notify::selected', () => {
            const unit = RETENTION_UNITS[retentionUnitRow.selected] ?? 'days';

            settings.set_string(SENSOR_HISTORY_RETENTION_UNIT_KEY, unit);
        });
        settings.connect(
            `changed::${SENSOR_HISTORY_RETENTION_UNIT_KEY}`,
            updateRetentionUnit);

        group.add(historyRow);
        group.add(retentionRow);
        group.add(retentionUnitRow);
        page.add(panelGroup);
        page.add(storageGroup);
        page.add(group);
        window.add(page);
    }
}
