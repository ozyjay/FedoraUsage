#!/usr/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo 'Run this installer as root.' >&2
    exit 1
fi

if [[ ! -x /usr/bin/tuned-adm ]]; then
    echo '/usr/bin/tuned-adm is required.' >&2
    exit 1
fi
if systemctl is-active --quiet power-profiles-daemon.service; then
    echo 'power-profiles-daemon is active; configure Fedora TuneD before installing Auto-Powersaver.' >&2
    exit 1
fi
if command -v rpm >/dev/null && ! rpm -q tuned-ppd >/dev/null 2>&1; then
    echo 'The tuned-ppd package is required so GNOME can display the active profile.' >&2
    exit 1
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
config_dir=/etc/fedorausage
config_path=${config_dir}/auto-powersaver.conf
legacy_unit=framework-thermal-policy.service
legacy_config=/etc/framework-thermal-policy.conf
created_config=false

install -d -m 0755 /usr/lib/fedorausage /usr/libexec /usr/bin "${config_dir}"
install -m 0644 "${source_dir}/auto_powersaver/__init__.py" /usr/lib/fedorausage/__init__.py
install -m 0644 "${source_dir}/auto_powersaver/core.py" /usr/lib/fedorausage/core.py
install -m 0755 "${source_dir}/auto_powersaver/service.py" /usr/libexec/fedorausage-auto-powersaver
install -m 0755 "${source_dir}/bin/fedorausage" /usr/bin/fedorausage
install -m 0644 "${source_dir}/data/fedorausage-auto-powersaver.service" \
    /usr/lib/systemd/system/fedorausage-auto-powersaver.service
install -m 0644 "${source_dir}/data/net.crunchycodes.FedoraUsage.AutoPowersaver1.service" \
    /usr/share/dbus-1/system-services/net.crunchycodes.FedoraUsage.AutoPowersaver1.service
install -m 0644 "${source_dir}/data/net.crunchycodes.FedoraUsage.AutoPowersaver1.conf" \
    /usr/share/dbus-1/system.d/net.crunchycodes.FedoraUsage.AutoPowersaver1.conf
install -m 0644 "${source_dir}/data/net.crunchycodes.fedorausage.policy" \
    /usr/share/polkit-1/actions/net.crunchycodes.fedorausage.policy

if [[ -e ${config_path} ]]; then
    backup_path=${config_path}.backup-$(date -u +%Y%m%dT%H%M%SZ)
    cp -a -- "${config_path}" "${backup_path}"
    echo "Kept existing configuration and created ${backup_path}."
else
    install -m 0600 "${source_dir}/data/auto-powersaver.conf" "${config_path}"
    created_config=true
fi

if [[ ${created_config} == true && -f ${legacy_config} ]]; then
    legacy_hot=$(sed -nE 's/^[[:space:]]*hot_threshold_c[[:space:]]*[:=][[:space:]]*([0-9]+).*$/\1/p' "${legacy_config}" | head -n 1)
    legacy_recovery=$(sed -nE 's/^[[:space:]]*recovery_threshold_c[[:space:]]*[:=][[:space:]]*([0-9]+).*$/\1/p' "${legacy_config}" | head -n 1)
    if [[ ${legacy_hot} =~ ^[0-9]+$ && ${legacy_recovery} =~ ^[0-9]+$ ]] &&
        (( legacy_hot >= 40 && legacy_hot <= 110 && legacy_recovery >= 30 && legacy_recovery < legacy_hot )); then
        sed -i -E "s/^hot_threshold_c = .*/hot_threshold_c = ${legacy_hot}/" "${config_path}"
        sed -i -E "s/^recovery_threshold_c = .*/recovery_threshold_c = ${legacy_recovery}/" "${config_path}"
        cp -a -- "${legacy_config}" "${legacy_config}.fedorausage-backup"
        echo "Migrated validated ${legacy_hot}°C/${legacy_recovery}°C thresholds from ${legacy_config}."
    else
        echo "Found ${legacy_config}, but did not migrate unrecognised or unsafe values."
    fi
    echo 'Control sensor identities use FedoraUsage fixed allowlists and were not copied from legacy configuration.'
fi

if systemctl list-unit-files "${legacy_unit}" --no-legend 2>/dev/null | grep -q "${legacy_unit}"; then
    systemctl disable --now "${legacy_unit}" || true
    echo "Disabled conflicting legacy controller ${legacy_unit}."
fi

systemctl daemon-reload
systemctl enable fedorausage-auto-powersaver.service
systemctl restart fedorausage-auto-powersaver.service
echo 'Installed and started fedorausage-auto-powersaver.service.'
