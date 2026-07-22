// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SENSOR_HISTORY_ENABLED_KEY = 'sensor-history-enabled';
const SENSOR_HISTORY_RETENTION_DAYS_KEY = 'sensor-history-retention-days';
const SENSOR_HISTORY_RETENTION_UNIT_KEY = 'sensor-history-retention-unit';
const SECONDARY_SSD_LOCATION_KEY = 'secondary-ssd-location';
const AUTO_POWERSAVER_BUS_NAME =
    'net.crunchycodes.FedoraUsage.AutoPowersaver1';
const AUTO_POWERSAVER_OBJECT_PATH =
    '/net/crunchycodes/FedoraUsage/AutoPowersaver1';
const AUTO_POWERSAVER_INTERFACE = AUTO_POWERSAVER_BUS_NAME;

const PANEL_ITEMS = [
    ['show-memory-in-panel', 'Memory', 'Show current memory use'],
    ['show-temperature-in-panel', 'Temperature', 'Show the hottest sensor reading'],
    ['show-fan-in-panel', 'Fan', 'Show Fan 1 while it is running'],
    ['show-system-filesystem-in-panel', 'System filesystem', 'Show usage for the filesystem mounted at /'],
    ['show-work-filesystem-in-panel', 'Secondary SSD', 'Show usage for the configured secondary SSD'],
    ['show-auto-powersaver-in-panel', 'Auto-Powersaver', 'Show policy mode and control temperature'],
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

        const autoGroup = new Adw.PreferencesGroup({
            title: 'Auto-Powersaver',
            description: 'Controls the root-owned system policy service through D-Bus. Changes may require administrator authentication.',
        });
        const autoEnabledRow = new Adw.SwitchRow({
            title: 'Enable Auto-Powersaver',
            subtitle: 'Automatically select Balanced or Power Saver from temperature',
            sensitive: false,
        });
        const hotAdjustment = new Gtk.Adjustment({
            lower: 40,
            upper: 110,
            step_increment: 1,
            page_increment: 5,
            value: 82,
        });
        const hotRow = new Adw.SpinRow({
            title: 'Hot threshold',
            subtitle: 'Power Saver is selected immediately at this temperature',
            adjustment: hotAdjustment,
            digits: 0,
        });
        const recoveryAdjustment = new Gtk.Adjustment({
            lower: 30,
            upper: 109,
            step_increment: 1,
            page_increment: 5,
            value: 72,
        });
        const recoveryRow = new Adw.SpinRow({
            title: 'Recovery threshold',
            subtitle: 'Must remain below the hot threshold',
            adjustment: recoveryAdjustment,
            digits: 0,
        });
        const dwellAdjustment = new Gtk.Adjustment({
            lower: 0,
            upper: 3600,
            step_increment: 5,
            page_increment: 30,
            value: 30,
        });
        const dwellRow = new Adw.SpinRow({
            title: 'Recovery dwell time',
            subtitle: 'Seconds at or below the recovery threshold',
            adjustment: dwellAdjustment,
        });
        const readingCountAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 100,
            step_increment: 1,
            page_increment: 5,
            value: 3,
        });
        const readingCountRow = new Adw.SpinRow({
            title: 'Recovery reading count',
            subtitle: 'Consecutive valid readings required for recovery',
            adjustment: readingCountAdjustment,
        });
        const pollAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 60,
            step_increment: 1,
            page_increment: 5,
            value: 5,
        });
        const pollRow = new Adw.SpinRow({
            title: 'Poll interval',
            subtitle: 'Seconds between service sensor readings',
            adjustment: pollAdjustment,
        });
        const overrideAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 1440,
            step_increment: 5,
            page_increment: 30,
            value: 30,
        });
        const overrideRow = new Adw.SpinRow({
            title: 'Manual override duration',
            subtitle: 'Minutes before returning to Automatic',
            adjustment: overrideAdjustment,
        });
        const degradedRow = new Adw.SwitchRow({
            title: 'Allow one-sensor degraded operation',
            subtitle: 'Use one valid approved control sensor when the other is unavailable',
        });
        const disableBehaviourRow = new Adw.ComboRow({
            title: 'Disable behaviour',
            subtitle: 'Default action when ordinary automation is disabled',
            model: Gtk.StringList.new(['Leave profile unchanged', 'Switch to Balanced']),
        });
        const applyPolicyRow = new Adw.ActionRow({
            title: 'Save policy settings',
            subtitle: 'Validates and writes the system-wide service configuration',
        });
        const applyPolicyButton = new Gtk.Button({
            label: 'Apply',
            valign: Gtk.Align.CENTER,
        });
        applyPolicyRow.add_suffix(applyPolicyButton);
        applyPolicyRow.activatable_widget = applyPolicyButton;
        const showGpuRow = new Adw.SwitchRow({
            title: 'Show GPU temperature',
            subtitle: 'Display the diagnostic-only amdgpu edge reading in the menu',
        });
        const notificationsRow = new Adw.SwitchRow({
            title: 'Show notifications',
            subtitle: 'Notify for protective, recovery and failed transitions',
        });
        settings.bind(
            'show-auto-powersaver-gpu-temperature', showGpuRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        settings.bind(
            'auto-powersaver-notifications-enabled', notificationsRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);

        for (const row of [
            autoEnabledRow,
            hotRow,
            recoveryRow,
            dwellRow,
            readingCountRow,
            pollRow,
            overrideRow,
            degradedRow,
            disableBehaviourRow,
            applyPolicyRow,
            showGpuRow,
            notificationsRow,
        ])
            autoGroup.add(row);

        const diagnosticsGroup = new Adw.PreferencesGroup({
            title: 'Auto-Powersaver diagnostics',
            description: 'Live read-only state reported by the system service.',
        });
        const diagnosticRows = new Map([
            ['policy_mode', new Adw.ActionRow({title: 'Policy mode', subtitle: 'Unavailable'})],
            ['thermal_state', new Adw.ActionRow({title: 'Thermal state', subtitle: 'Unknown'})],
            ['telemetry_quality', new Adw.ActionRow({title: 'Control sensor health', subtitle: 'Unknown'})],
            ['service_health', new Adw.ActionRow({title: 'Service health', subtitle: 'Service unavailable'})],
            ['control_temperature_c', new Adw.ActionRow({title: 'Control temperature', subtitle: 'Unavailable'})],
            ['active_profile', new Adw.ActionRow({title: 'Current TuneD profile', subtitle: 'Unavailable'})],
            ['last_transition', new Adw.ActionRow({title: 'Last transition', subtitle: 'None'})],
            ['last_error', new Adw.ActionRow({title: 'Last service error', subtitle: 'None'})],
        ]);
        for (const row of diagnosticRows.values())
            diagnosticsGroup.add(row);
        page.add(autoGroup);
        page.add(diagnosticsGroup);

        let autoProxy = null;
        let updatingAutoRows = false;
        let currentAutoStatus = null;
        const setPolicySensitive = sensitive => {
            for (const row of [
                autoEnabledRow, hotRow, recoveryRow, dwellRow, readingCountRow,
                pollRow, overrideRow, degradedRow, disableBehaviourRow,
                applyPolicyRow,
            ])
                row.sensitive = sensitive;
        };
        const applyStatus = status => {
            currentAutoStatus = status;
            updatingAutoRows = true;
            autoEnabledRow.active = Boolean(status.enabled);
            hotAdjustment.value = status.hot_threshold_c;
            recoveryAdjustment.value = status.recovery_threshold_c;
            dwellAdjustment.value = status.recovery_dwell_seconds;
            readingCountAdjustment.value = status.recovery_reading_count;
            pollAdjustment.value = status.poll_interval_seconds;
            overrideAdjustment.value = status.manual_override_seconds / 60;
            degradedRow.active = status.allow_single_sensor_degraded_operation;
            disableBehaviourRow.selected =
                status.disable_behavior === 'balanced' ? 1 : 0;
            updatingAutoRows = false;
            setPolicySensitive(true);

            diagnosticRows.get('policy_mode').subtitle =
                status.policy_mode.replace(/_/g, ' ');
            diagnosticRows.get('thermal_state').subtitle =
                status.thermal_state.replace(/_/g, ' ');
            diagnosticRows.get('telemetry_quality').subtitle =
                `${status.telemetry_quality.replace(/_/g, ' ')} ` +
                `(${status.telemetry_age_seconds.toFixed(1)} s old)`;
            diagnosticRows.get('service_health').subtitle =
                status.service_health.replace(/_/g, ' ');
            diagnosticRows.get('control_temperature_c').subtitle =
                status.control_temperature_c === null
                    ? 'Unavailable'
                    : `${status.control_temperature_c.toFixed(1)}°C`;
            diagnosticRows.get('active_profile').subtitle =
                status.active_profile ?? 'Unavailable';
            diagnosticRows.get('last_transition').subtitle =
                status.last_transition?.reason?.replace(/_/g, ' ') ?? 'None';
            diagnosticRows.get('last_error').subtitle = status.last_error ?? 'None';
        };
        const callService = (method, parameters = null, callback = null) => {
            if (!autoProxy)
                return;
            autoProxy.call(
                method, parameters, Gio.DBusCallFlags.NONE, 120000, null,
                (proxy, result) => {
                    try {
                        const [payload] = proxy.call_finish(result).deepUnpack();
                        const status = JSON.parse(payload);

                        applyStatus(status);
                        callback?.(status);
                        autoGroup.description =
                            'Controls the root-owned system policy service through D-Bus.';
                    } catch (error) {
                        autoGroup.description = `Request failed: ${error.message}`;
                        if (method === 'GetStatus')
                            setPolicySensitive(false);
                        else
                            callService('GetStatus');
                    }
                });
        };

        autoEnabledRow.connect('notify::active', () => {
            if (updatingAutoRows)
                return;
            callService(
                autoEnabledRow.active ? 'Enable' : 'Disable',
                autoEnabledRow.active
                    ? null
                    : new GLib.Variant('(b)', [
                        currentAutoStatus?.disable_behavior === 'balanced' &&
                        !currentAutoStatus?.hot_latched &&
                        currentAutoStatus?.control_temperature_c !== null &&
                        currentAutoStatus?.telemetry_age_seconds <=
                            currentAutoStatus?.poll_interval_seconds * 2,
                    ]));
        });
        applyPolicyButton.connect('clicked', () => {
            const hot = hotAdjustment.value;
            const recovery = recoveryAdjustment.value;

            if (recovery >= hot) {
                autoGroup.description =
                    'Recovery temperature must be below the hot threshold.';
                return;
            }
            callService(
                'SetThresholds', new GLib.Variant('(dd)', [hot, recovery]),
                () => callService(
                    'SetPolicyOptions',
                    new GLib.Variant('(uuuub)', [
                        Math.round(pollAdjustment.value),
                        Math.round(dwellAdjustment.value),
                        Math.round(readingCountAdjustment.value),
                        Math.round(overrideAdjustment.value * 60),
                        degradedRow.active,
                    ]),
                    () => callService(
                        'SetDisableBehaviour',
                        new GLib.Variant('(s)', [
                            disableBehaviourRow.selected === 1
                                ? 'balanced'
                                : 'leave_unchanged',
                        ]))));
        });

        setPolicySensitive(false);
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            null,
            AUTO_POWERSAVER_BUS_NAME,
            AUTO_POWERSAVER_OBJECT_PATH,
            AUTO_POWERSAVER_INTERFACE,
            null,
            (_source, result) => {
                try {
                    autoProxy = Gio.DBusProxy.new_for_bus_finish(result);
                    autoProxy.connect('g-signal', (_proxy, _sender, signalName, parameters) => {
                        if (signalName !== 'StatusChanged')
                            return;
                        const [payload] = parameters.deepUnpack();

                        applyStatus(JSON.parse(payload));
                    });
                    callService('GetStatus');
                } catch (error) {
                    autoGroup.description =
                        `Auto-Powersaver service unavailable: ${error.message}`;
                    setPolicySensitive(false);
                }
            });
        window.add(page);
    }
}
