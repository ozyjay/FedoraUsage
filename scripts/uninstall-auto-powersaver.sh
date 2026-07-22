#!/usr/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
    echo 'Run this uninstaller as root.' >&2
    exit 1
fi

remove_config=false
switch_balanced=false
for argument in "$@"; do
    case "${argument}" in
        --remove-config) remove_config=true ;;
        --balanced) switch_balanced=true ;;
        *) echo "Unknown option: ${argument}" >&2; exit 2 ;;
    esac
done

systemctl disable --now fedorausage-auto-powersaver.service 2>/dev/null || true
if [[ ${switch_balanced} == true ]]; then
    /usr/bin/tuned-adm profile balanced
fi

rm -f -- /usr/lib/systemd/system/fedorausage-auto-powersaver.service
rm -f -- /usr/share/dbus-1/system-services/net.crunchycodes.FedoraUsage.AutoPowersaver1.service
rm -f -- /usr/share/dbus-1/system.d/net.crunchycodes.FedoraUsage.AutoPowersaver1.conf
rm -f -- /usr/share/polkit-1/actions/net.crunchycodes.fedorausage.policy
rm -f -- /usr/libexec/fedorausage-auto-powersaver /usr/bin/fedorausage
rm -f -- /usr/lib/fedorausage/__init__.py /usr/lib/fedorausage/core.py
rmdir --ignore-fail-on-non-empty /usr/lib/fedorausage
rm -rf -- /run/fedorausage-auto-powersaver
if [[ ${remove_config} == true ]]; then
    rm -f -- /etc/fedorausage/auto-powersaver.conf
    rmdir --ignore-fail-on-non-empty /etc/fedorausage
fi
systemctl daemon-reload
echo 'Removed the Auto-Powersaver service. The active TuneD profile was left unchanged unless --balanced was supplied.'
