#!/usr/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

acknowledgement=--i-understand-this-changes-the-system-power-profile
if [[ ${1:-} != "${acknowledgement}" ]]; then
    echo "Usage: $0 ${acknowledgement}" >&2
    echo 'This opt-in test changes Auto-Powersaver thresholds and the host TuneD profile.' >&2
    exit 2
fi

for command in fedorausage jq /usr/bin/tuned-adm; do
    if ! command -v "${command}" >/dev/null; then
        echo "Required command not found: ${command}" >&2
        exit 1
    fi
done

audit_dir=${HOME}/System\ Usage\ Logs
mkdir -p -m 0700 -- "${audit_dir}"
audit_path=${audit_dir}/auto-powersaver-audit-$(date +%Y%m%dT%H%M%S).jsonl
initial_status=$(fedorausage auto-powersaver status)
initial_enabled=$(jq -r '.enabled' <<<"${initial_status}")
initial_mode=$(jq -r '.policy_mode' <<<"${initial_status}")
initial_profile=$(jq -r '.active_profile' <<<"${initial_status}")
initial_hot=$(jq -r '.hot_threshold_c' <<<"${initial_status}")
initial_recovery=$(jq -r '.recovery_threshold_c' <<<"${initial_status}")

if [[ ${initial_mode} != automatic && ${initial_mode} != disabled ]]; then
    echo "Start from Automatic or Disabled, not ${initial_mode}." >&2
    exit 1
fi
if [[ ${initial_profile} != balanced && ${initial_profile} != powersave ]]; then
    echo "The initial TuneD profile is outside the supported restoration set: ${initial_profile}" >&2
    exit 1
fi

record_status() {
    local step=$1
    fedorausage auto-powersaver status |
        jq -c --arg step "${step}" '{timestamp:(now | todateiso8601), step:$step, status:.}' |
        tee -a "${audit_path}"
}

record_note() {
    local step=$1
    local outcome=$2
    jq -nc --arg step "${step}" --arg outcome "${outcome}" \
        '{timestamp:(now | todateiso8601), step:$step, outcome:$outcome}' |
        tee -a "${audit_path}"
}

restore_host() {
    set +e
    fedorausage auto-powersaver set-thresholds "${initial_hot}" "${initial_recovery}" >/dev/null
    if [[ ${initial_enabled} == true ]]; then
        fedorausage auto-powersaver enable >/dev/null
        fedorausage auto-powersaver force "${initial_profile}" >/dev/null
        if [[ ${initial_mode} == automatic ]]; then
            fedorausage auto-powersaver automatic >/dev/null
        fi
    else
        fedorausage auto-powersaver enable >/dev/null
        fedorausage auto-powersaver force "${initial_profile}" >/dev/null
        fedorausage auto-powersaver disable >/dev/null
    fi
    record_status restoration_complete
    set -e
}
trap restore_host EXIT
trap 'exit 130' INT TERM

jq -c --arg step initial '{timestamp:(now | todateiso8601), step:$step, status:.}' \
    <<<"${initial_status}" | tee -a "${audit_path}"

control_temperature=$(jq -r '.control_temperature_c // empty' <<<"${initial_status}")
calculated_max=$(jq -r '[
    .sensor_readings["k10temp/Tctl"],
    .sensor_readings["cros_ec/cpu@4c"]
  ] | map(select(.valid) | .temperature_c) | if length == 0 then empty else max end' \
    <<<"${initial_status}")
if [[ -z ${control_temperature} || -z ${calculated_max} || ${control_temperature} != "${calculated_max}" ]]; then
    record_note control_temperature failed
    exit 1
fi
record_note control_temperature "passed: maximum is ${calculated_max}°C"

tuned_output=$(/usr/bin/tuned-adm active)
if [[ ${tuned_output} != *"${initial_profile}"* ]]; then
    record_note tuned_profile_match failed
    exit 1
fi
record_note tuned_profile_match passed

hot_threshold=$(jq -nr --argjson value "${control_temperature}" \
    '$value | floor | if . < 40 then 40 elif . > 110 then 110 else . end')
recovery_threshold=$((hot_threshold - 5))
if (( recovery_threshold < 30 )); then
    record_note protective_transition 'skipped: current temperature is below the minimum safe test threshold'
    exit 1
fi

fedorausage auto-powersaver enable >/dev/null
fedorausage auto-powersaver pause 15m >/dev/null
fedorausage auto-powersaver set-thresholds "${hot_threshold}" "${recovery_threshold}" >/dev/null
sleep 8
record_status hot_safety_while_paused
if [[ $(fedorausage auto-powersaver status | jq -r '.active_profile') != powersave ]]; then
    record_note immediate_powersave failed
    exit 1
fi
record_note immediate_powersave passed
if fedorausage auto-powersaver force balanced >/dev/null 2>&1; then
    record_note force_balanced_while_hot failed
    exit 1
else
    record_note force_balanced_while_hot passed
fi
record_note gnome_live_update 'manual confirmation required: extension and GNOME Settings show Power Saver without reopening'

fedorausage auto-powersaver set-thresholds "${initial_hot}" "${initial_recovery}" >/dev/null
fedorausage auto-powersaver resume >/dev/null
record_note recovery 'observe dwell and consecutive readings before continuing'
sleep 45
record_status validated_recovery

fedorausage auto-powersaver pause 1m >/dev/null
record_status pause_started
sleep 68
if [[ $(fedorausage auto-powersaver status | jq -r '.policy_mode') != automatic ]]; then
    record_note pause_automatic_resume failed
    exit 1
fi
record_note pause_automatic_resume passed

fedorausage auto-powersaver force balanced >/dev/null
record_status manual_balanced
fedorausage auto-powersaver force powersave >/dev/null
record_status manual_powersave
fedorausage auto-powersaver automatic >/dev/null
record_status returned_to_automatic

external_profile=balanced
if [[ $(fedorausage auto-powersaver status | jq -r '.active_profile') == balanced ]]; then
    external_profile=powersave
fi
/usr/bin/tuned-adm profile "${external_profile}"
sleep 8
record_status external_profile_change

record_note sensor_loss_tctl 'requires fake-hwmon integration environment; production driver unbinding is intentionally unsupported'
record_note sensor_loss_ec 'requires fake-hwmon integration environment; production driver unbinding is intentionally unsupported'
record_note sensor_loss_both 'requires fake-hwmon integration environment; production driver unbinding is intentionally unsupported'
record_note audit_path "${audit_path}"
echo "Manual validation complete; audit: ${audit_path}"
