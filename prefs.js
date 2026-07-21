// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SENSOR_HISTORY_ENABLED_KEY = 'sensor-history-enabled';
const SENSOR_HISTORY_RETENTION_DAYS_KEY = 'sensor-history-retention-days';

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
            upper: 365,
            step_increment: 1,
            page_increment: 7,
            value: 7,
        });
        const retentionRow = new Adw.SpinRow({
            title: 'Retention length',
            subtitle: 'Number of local calendar days to keep',
            adjustment: retentionAdjustment,
        });

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

        group.add(historyRow);
        group.add(retentionRow);
        page.add(group);
        window.add(page);
    }
}
