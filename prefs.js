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
const AUTO_OPERATING_MODES = ['automatic', 'protection_only', 'off'];
const AUTO_OPERATING_MODE_LABELS = ['Automatic', 'Hot protection only', 'Off'];
const AUTO_OPERATING_MODE_DESCRIPTIONS = {
    automatic: 'Use Balanced while cool and Power Saver when hot',
    protection_only: 'Keep the current profile while cool and use Power Saver when hot',
    off: 'Never change the power profile automatically',
};
const AUTO_REASON_LABELS = {
    automatic_normal: 'Automatic — cool',
    automatic_hot: 'Automatic — hot',
    hot_protection_while_disabled: 'Hot protection',
    manual_override: 'Manual override',
    external_profile_change: 'External profile change',
    forced_power_saver: 'Forced Power Saver',
    forced_balanced: 'Forced Balanced',
    recovery: 'Recovery',
    profile_unchanged: 'External or unchanged',
    tuned_unavailable: 'TuneD unavailable',
    telemetry_unknown: 'Telemetry unknown',
};

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
            title: 'Auto-Powersaver policy',
            description: 'Controls the root-owned system policy service through D-Bus. Changes may require administrator authentication.',
        });
        const operatingModeRow = new Adw.ComboRow({
            title: 'Operating mode',
            subtitle: 'Choose when FedoraUsage changes the power profile',
            model: Gtk.StringList.new(AUTO_OPERATING_MODE_LABELS),
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
            subtitle: 'Profile action when leaving Automatic mode',
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
            operatingModeRow,
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
            ['operating_mode', new Adw.ActionRow({title: 'Operating mode', subtitle: 'Unavailable'})],
            ['service_running', new Adw.ActionRow({title: 'Root service', subtitle: 'Unavailable'})],
            ['policy_mode', new Adw.ActionRow({title: 'Runtime state', subtitle: 'Unavailable'})],
            ['thermal_state', new Adw.ActionRow({title: 'Thermal state', subtitle: 'Unknown'})],
            ['telemetry_quality', new Adw.ActionRow({title: 'Control sensor health', subtitle: 'Unknown'})],
            ['service_health', new Adw.ActionRow({title: 'Service health', subtitle: 'Service unavailable'})],
            ['control_temperature_c', new Adw.ActionRow({title: 'Control temperature', subtitle: 'Unavailable'})],
            ['active_profile', new Adw.ActionRow({title: 'Current TuneD profile', subtitle: 'Unavailable'})],
            ['effective_profile_reason', new Adw.ActionRow({title: 'Effective profile reason', subtitle: 'Unknown'})],
            ['last_transition', new Adw.ActionRow({title: 'Last transition', subtitle: 'None'})],
            ['last_error', new Adw.ActionRow({title: 'Last service error', subtitle: 'None'})],
        ]);
        for (const row of diagnosticRows.values())
            diagnosticsGroup.add(row);
        page.add(autoGroup);
        page.add(diagnosticsGroup);

        const externalGroup = new Adw.PreferencesGroup({
            title: 'External-control diagnostics',
            description: 'Bounded, read-only checks; FedoraUsage never changes detected controllers.',
        });
        const externalChangesRow = new Adw.ActionRow({
            title: 'External profile changes observed',
            subtitle: 'Unavailable',
        });
        const competingControllersRow = new Adw.ActionRow({
            title: 'Competing power controllers',
            subtitle: 'Not scanned',
        });
        const conflictScanRow = new Adw.ActionRow({
            title: 'Conflict scan',
            subtitle: 'Not scanned',
        });
        const conflictDetailsRow = new Adw.ExpanderRow({
            title: 'Potential controller details',
            subtitle: 'No findings loaded',
        });
        let conflictDetailRows = [];
        const rescanButton = new Gtk.Button({label: 'Rescan', valign: Gtk.Align.CENTER});
        conflictScanRow.add_suffix(rescanButton);
        conflictScanRow.activatable_widget = rescanButton;
        for (const row of [
            externalChangesRow, competingControllersRow, conflictScanRow,
            conflictDetailsRow,
        ])
            externalGroup.add(row);
        page.add(externalGroup);

        let autoProxy = null;
        let updatingAutoRows = false;
        let currentAutoStatus = null;
        let policyRowsDirty = false;
        const operatingModeFromStatus = status => status?.operating_mode ?? (
            status?.enabled
                ? 'automatic'
                : status?.hot_protection_when_disabled ? 'protection_only' : 'off');
        const markPolicyRowsDirty = () => {
            if (updatingAutoRows)
                return;

            policyRowsDirty = true;
            applyPolicyRow.subtitle = 'Unsaved policy settings';
        };
        for (const adjustment of [
            hotAdjustment,
            recoveryAdjustment,
            dwellAdjustment,
            readingCountAdjustment,
            pollAdjustment,
            overrideAdjustment,
        ])
            adjustment.connect('notify::value', markPolicyRowsDirty);
        degradedRow.connect('notify::active', markPolicyRowsDirty);
        disableBehaviourRow.connect('notify::selected', markPolicyRowsDirty);

        const setPolicySensitive = sensitive => {
            for (const row of [
                operatingModeRow, hotRow, recoveryRow, dwellRow, readingCountRow,
                pollRow, overrideRow, degradedRow, disableBehaviourRow,
                applyPolicyRow,
            ])
                row.sensitive = sensitive;
        };
        const applyStatus = status => {
            currentAutoStatus = status;
            updatingAutoRows = true;
            const operatingMode = operatingModeFromStatus(status);
            operatingModeRow.selected = Math.max(
                AUTO_OPERATING_MODES.indexOf(operatingMode), 0);
            operatingModeRow.subtitle =
                AUTO_OPERATING_MODE_DESCRIPTIONS[operatingMode] ?? 'Unknown mode';
            if (!policyRowsDirty) {
                hotAdjustment.value = status.hot_threshold_c;
                recoveryAdjustment.value = status.recovery_threshold_c;
                dwellAdjustment.value = status.recovery_dwell_seconds;
                readingCountAdjustment.value = status.recovery_reading_count;
                pollAdjustment.value = status.poll_interval_seconds;
                overrideAdjustment.value = status.manual_override_seconds / 60;
                degradedRow.active =
                    status.allow_single_sensor_degraded_operation;
                disableBehaviourRow.selected =
                    status.disable_behavior === 'balanced' ? 1 : 0;
            }
            updatingAutoRows = false;
            setPolicySensitive(true);

            diagnosticRows.get('operating_mode').subtitle =
                AUTO_OPERATING_MODE_LABELS[
                    Math.max(AUTO_OPERATING_MODES.indexOf(operatingMode), 0)];
            diagnosticRows.get('service_running').subtitle =
                status.service_running ? 'Running' : 'Unavailable';

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
            diagnosticRows.get('effective_profile_reason').subtitle =
                AUTO_REASON_LABELS[status.effective_profile_reason] ??
                status.effective_profile_reason?.replace(/_/g, ' ') ?? 'Unknown';
            diagnosticRows.get('last_transition').subtitle =
                status.last_transition?.reason?.replace(/_/g, ' ') ?? 'None';
            diagnosticRows.get('last_error').subtitle = status.last_error ?? 'None';
            externalChangesRow.subtitle = status.external_profile_change_observed
                ? `Yes (${status.external_change_count})`
                : 'No';
            const count = status.potential_competing_controller_count ?? 0;
            competingControllersRow.subtitle = count === 0
                ? 'None detected'
                : `${count} potential conflict${count === 1 ? '' : 's'}`;
            conflictScanRow.subtitle = status.conflict_scan_timestamp
                ? `${status.conflict_scan_status.replace(/_/g, ' ')} — ${status.conflict_scan_timestamp}`
                : status.conflict_scan_status?.replace(/_/g, ' ') ?? 'Not scanned';
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

        const restoreBalancedWhenSafe = () =>
            currentAutoStatus?.disable_behavior === 'balanced' &&
            !currentAutoStatus?.hot_latched &&
            currentAutoStatus?.control_temperature_c !== null &&
            currentAutoStatus?.telemetry_age_seconds <=
                currentAutoStatus?.poll_interval_seconds * 2;
        const setOperatingMode = mode => callService(
            'SetOperatingMode',
            new GLib.Variant('(sb)', [mode, restoreBalancedWhenSafe()]));

        operatingModeRow.connect('notify::selected', () => {
            if (updatingAutoRows)
                return;
            const mode = AUTO_OPERATING_MODES[operatingModeRow.selected];

            if (mode !== 'off') {
                setOperatingMode(mode);
                return;
            }
            updatingAutoRows = true;
            operatingModeRow.selected = Math.max(
                AUTO_OPERATING_MODES.indexOf(
                    operatingModeFromStatus(currentAutoStatus)), 0);
            updatingAutoRows = false;
            const dialog = new Adw.AlertDialog({
                heading: 'Turn Auto-Powersaver off?',
                body: 'FedoraUsage will stop changing power profiles, including at the hot threshold. Hardware and firmware thermal protections remain independent, and the root service will keep running for status and diagnostics.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('turn-off', 'Turn off');
            dialog.set_response_appearance('turn-off', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.choose(window, null, (_dialog, result) => {
                if (dialog.choose_finish(result) === 'turn-off')
                    setOperatingMode('off');
            });
        });
        const applyConflictStatus = conflict => {
            const count = conflict.potential_competing_controller_count ?? 0;
            competingControllersRow.subtitle = count === 0
                ? 'None detected'
                : `${count} potential conflict${count === 1 ? '' : 's'}`;
            conflictScanRow.subtitle =
                `${conflict.status.replace(/_/g, ' ')} — ${conflict.scan_timestamp}`;
            conflictDetailsRow.subtitle = conflict.scan_complete
                ? `${count} bounded finding${count === 1 ? '' : 's'}`
                : 'Partial scan; some locations or status data were unavailable';
            for (const child of conflictDetailRows)
                conflictDetailsRow.remove(child);
            conflictDetailRows = (conflict.potential_competing_controllers ?? []).map(
                finding => new Adw.ActionRow({
                    title: finding.name,
                    subtitle: `${finding.scope}; ${finding.type}; ${finding.active ? 'active' : 'inactive'}; ${finding.enabled ? 'enabled' : 'not enabled'}; ${finding.confidence} confidence; ${finding.risk}; ${finding.evidence.join('; ')}${finding.safe_inspection_commands.length > 0 ? `; Inspect: ${finding.safe_inspection_commands.join(' ; ')}` : ''}`,
                }));
            for (const child of conflictDetailRows)
                conflictDetailsRow.add_row(child);
        };
        const loadConflictStatus = (method = 'GetConflictStatus') => {
            if (!autoProxy)
                return;
            rescanButton.sensitive = false;
            autoProxy.call(
                method, null, Gio.DBusCallFlags.NONE, 120000, null,
                (proxy, result) => {
                    try {
                        const [payload] = proxy.call_finish(result).deepUnpack();
                        applyConflictStatus(JSON.parse(payload));
                    } catch (error) {
                        conflictScanRow.subtitle = `Rescan failed: ${error.message}`;
                    } finally {
                        rescanButton.sensitive = true;
                    }
                });
        };
        rescanButton.connect('clicked', () => loadConflictStatus('RescanConflicts'));
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
                        ]),
                        status => {
                            policyRowsDirty = false;
                            applyPolicyRow.subtitle = 'Policy settings saved';
                            applyStatus(status);
                        })));
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
                    loadConflictStatus();
                } catch (error) {
                    autoGroup.description =
                        `Auto-Powersaver service unavailable: ${error.message}`;
                    setPolicySensitive(false);
                }
            });
        window.add(page);
    }
}
