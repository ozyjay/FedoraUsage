// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SENSOR_HISTORY_ENABLED_KEY = 'sensor-history-enabled';
const SENSOR_HISTORY_RETENTION_DAYS_KEY = 'sensor-history-retention-days';
const SENSOR_HISTORY_RETENTION_UNIT_KEY = 'sensor-history-retention-unit';

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
        page.add(group);
        window.add(page);
    }
}
