#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/http-metrics-monitor.sh --check <ssh-alias>
  scripts/http-metrics-monitor.sh --apply <ssh-alias>
  scripts/http-metrics-monitor.sh --update <ssh-alias>
  scripts/http-metrics-monitor.sh --summary <ssh-alias> [days]
  scripts/http-metrics-monitor.sh --rollback <ssh-alias> <remote-backup-directory>

The monitor records only epoch, status code and duration. Check and summary are
read-only. Apply is for a new installation; update requires an existing one.
Every write mode creates a rollback backup and preserves numeric history.
EOF
}

[[ $# -ge 2 ]] || { usage; exit 2; }
mode=$1
target=$2
case "$mode" in --check|--apply|--update|--summary|--rollback) ;; *) usage; exit 2 ;; esac

ssh_bin=${SSH_COMMAND:-ssh}
scp_bin=${SCP_COMMAND:-scp}
ssh_args=(-o BatchMode=yes -o ConnectTimeout=8)
scp_args=(-q)
if [[ -n "${SSH_CONFIG:-}" ]]; then
  ssh_args=(-F "$SSH_CONFIG" "${ssh_args[@]}")
  scp_args=(-F "$SSH_CONFIG" "${scp_args[@]}")
fi

check_command=$(cat <<'REMOTE'
set -euo pipefail
sudo -n true
for command_name in apachectl httpd awk dd stat sort find logrotate df tail sed wc; do command -v "$command_name" >/dev/null; done
test -x /usr/sbin/rotatelogs
# Fixed supported layout; native circular rotation bounds disk use independently of timers.
free_kb=$(df -Pk /var/log/httpd | awk 'NR==2 {print $4}')
[[ "$free_kb" =~ ^[0-9]+$ ]] && ((free_kb >= 131072)) || { printf '%s\n' 'Need at least 128 MiB free in /var/log/httpd' >&2; exit 1; }
dd --help 2>&1 | grep count_bytes >/dev/null
sudo -n httpd -M 2>/dev/null | grep log_config_module >/dev/null
sudo -n httpd -M 2>/dev/null | grep env_module >/dev/null
if sudo -n test -f /etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf; then
  sudo -n grep -Eq '^[[:space:]]*SetEnv ops_toolkit_internal_monitor 1[[:space:]]*$' /etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf || {
    printf '%s\n' 'Incompatible PHP status VirtualHost: internal monitor marker required; automatic update refused.' >&2
    exit 1
  }
fi
systemctl is-active httpd >/dev/null
sudo -n apachectl configtest >/dev/null
if sudo -n test -f /etc/systemd/system/ops-toolkit-http-metrics-monitor.timer; then installed=yes; else installed=no; fi
printf 'preflight=ok\nhttpd=active\nmonitor_installed=%s\n' "$installed"
REMOTE
)

if [[ "$mode" == "--check" ]]; then
  [[ $# -eq 2 ]] || { usage; exit 2; }
  "$ssh_bin" "${ssh_args[@]}" "$target" "$check_command"
  exit 0
fi

if [[ "$mode" == "--summary" ]]; then
  [[ $# -le 3 ]] || { usage; exit 2; }
  days=${3:-14}
  [[ "$days" =~ ^[0-9]+$ ]] && ((days >= 1 && days <= 35)) || { printf '%s\n' 'days must be 1..35' >&2; exit 2; }
  summary_script=$(cat "$(dirname -- "${BASH_SOURCE[0]}")/monitor-summary.sh")
  printf '%s\nmonitor_summary http %s\n' "$summary_script" "$days" | "$ssh_bin" "${ssh_args[@]}" "$target" 'bash -s'
  exit 0
fi

if [[ "$mode" == "--rollback" ]]; then
  [[ $# -eq 3 ]] || { usage; exit 2; }
  backup=$3
  [[ "$backup" =~ ^/var/backups/ops-toolkit/http-metrics/[0-9]{8}T[0-9]{6}Z$ ]] || { printf 'Invalid backup: %s\n' "$backup" >&2; exit 2; }
  "$ssh_bin" "${ssh_args[@]}" "$target" "set -euo pipefail
BACKUP='$backup'; CONF=/etc/httpd/conf.d/ops-toolkit-request-metrics.conf; ROTATE=/etc/logrotate.d/ops-toolkit-request-metrics; SAMPLE=/usr/local/libexec/ops-toolkit-http-metrics-monitor; SERVICE=/etc/systemd/system/ops-toolkit-http-metrics-monitor.service; TIMER=/etc/systemd/system/ops-toolkit-http-metrics-monitor.timer; VALID=/var/lib/ops-toolkit/http-history/valid-since; PRODUCER=/var/lib/ops-toolkit/http-history/producer-version; HOOK=/usr/local/libexec/ops-toolkit-http-metrics-rotation
restore_file() { saved=\$1; destination=\$2; if sudo -n test -f \"\$BACKUP/\$saved\"; then sudo -n cp -p \"\$BACKUP/\$saved\" \"\$destination\"; else sudo -n rm -f \"\$destination\"; fi; }
sudo -n test -d \"\$BACKUP\"
sudo -n test ! -e \"\$BACKUP/backup.incomplete\"
sudo -n systemctl disable --now ops-toolkit-http-metrics-monitor.timer 2>/dev/null || true
sudo -n systemctl stop ops-toolkit-http-metrics-monitor.service 2>/dev/null || true
restore_file httpd.conf \"\$CONF\"; restore_file logrotate.conf \"\$ROTATE\"; restore_file sample.sh \"\$SAMPLE\"; restore_file rotation.sh \"\$HOOK\"; restore_file monitor.service \"\$SERVICE\"; restore_file monitor.timer \"\$TIMER\"; restore_file producer-version \"\$PRODUCER\"; restore_file valid-since \"\$VALID\"
sudo -n apachectl configtest
sudo -n systemctl daemon-reload
sudo -n systemctl reload httpd
if sudo -n test -f \"\$BACKUP/timer.enabled\"; then sudo -n systemctl enable ops-toolkit-http-metrics-monitor.timer >/dev/null; fi
if sudo -n test -f \"\$BACKUP/timer.active\" || { ! sudo -n test -f \"\$BACKUP/timer.state-recorded\" && sudo -n test -f \"\$BACKUP/timer.enabled\"; }; then sudo -n systemctl start ops-toolkit-http-metrics-monitor.timer; fi
printf 'rollback=%s\nhistory_preserved=/var/lib/ops-toolkit/http-history\n' \"\$BACKUP\""
  exit 0
fi

[[ $# -eq 2 ]] || { usage; exit 2; }
"$ssh_bin" "${ssh_args[@]}" "$target" "$check_command"
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
remote_tmp=$("$ssh_bin" "${ssh_args[@]}" "$target" 'mktemp -d /tmp/ops-toolkit-http-metrics.XXXXXX')
[[ "$remote_tmp" =~ ^/tmp/ops-toolkit-http-metrics[.][A-Za-z0-9]+$ ]] || { printf 'Unexpected remote temp path: %s\n' "$remote_tmp" >&2; exit 1; }
cleanup_remote() { "$ssh_bin" "${ssh_args[@]}" "$target" "rm -rf '$remote_tmp'" >/dev/null 2>&1 || true; }
trap cleanup_remote EXIT

"$scp_bin" "${scp_args[@]}" "$repo_dir/config/http-metrics-sample.sh" "$target:$remote_tmp/sample.sh"
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/http-metrics-rotation.sh" "$target:$remote_tmp/rotation.sh"
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/http-metrics-httpd.conf" "$target:$remote_tmp/httpd.conf"
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/http-metrics-logrotate.conf" "$target:$remote_tmp/logrotate.conf"
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/http-metrics-monitor.service" "$target:$remote_tmp/monitor.service"
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/http-metrics-monitor.timer" "$target:$remote_tmp/monitor.timer"

"$ssh_bin" "${ssh_args[@]}" "$target" "set -euo pipefail
SOURCE='$remote_tmp'; ACTION='$mode'; CONF=/etc/httpd/conf.d/ops-toolkit-request-metrics.conf; ROTATE=/etc/logrotate.d/ops-toolkit-request-metrics; SAMPLE=/usr/local/libexec/ops-toolkit-http-metrics-monitor; SERVICE=/etc/systemd/system/ops-toolkit-http-metrics-monitor.service; TIMER=/etc/systemd/system/ops-toolkit-http-metrics-monitor.timer; VALID=/var/lib/ops-toolkit/http-history/valid-since; PRODUCER=/var/lib/ops-toolkit/http-history/producer-version; HOOK=/usr/local/libexec/ops-toolkit-http-metrics-rotation
if [[ \"\$ACTION\" == '--apply' ]]; then sudo -n test ! -e \"\$TIMER\"; else sudo -n test -f \"\$TIMER\"; sudo -n test -f \"\$CONF\"; fi
BACKUP=/var/backups/ops-toolkit/http-metrics/\$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_READY=0
restore_file() { saved=\$1; destination=\$2; if sudo -n test -f \"\$BACKUP/\$saved\"; then sudo -n cp -p \"\$BACKUP/\$saved\" \"\$destination\"; else sudo -n rm -f \"\$destination\"; fi; }
restore_on_error() {
  status=\$?
  if ((status && BACKUP_READY == 1)); then
    sudo -n systemctl disable --now ops-toolkit-http-metrics-monitor.timer >/dev/null 2>&1 || true
    sudo -n systemctl stop ops-toolkit-http-metrics-monitor.service >/dev/null 2>&1 || true
    restore_file httpd.conf \"\$CONF\" || true; restore_file logrotate.conf \"\$ROTATE\" || true
    restore_file sample.sh \"\$SAMPLE\" || true; restore_file rotation.sh \"\$HOOK\" || true; restore_file monitor.service \"\$SERVICE\" || true
    restore_file monitor.timer \"\$TIMER\" || true; restore_file producer-version \"\$PRODUCER\" || true; restore_file valid-since \"\$VALID\" || true
    sudo -n systemctl daemon-reload >/dev/null 2>&1 || true
    sudo -n apachectl configtest >/dev/null 2>&1 && sudo -n systemctl reload httpd || true
    if sudo -n test -f \"\$BACKUP/timer.enabled\"; then sudo -n systemctl enable ops-toolkit-http-metrics-monitor.timer >/dev/null 2>&1 || true; fi
    if sudo -n test -f \"\$BACKUP/timer.active\"; then sudo -n systemctl start ops-toolkit-http-metrics-monitor.timer || true; fi
  fi
  exit \$status
}
trap restore_on_error EXIT
sudo -n install -d -o root -g root -m 0750 /var/backups/ops-toolkit/http-metrics /var/lib/ops-toolkit/http-history
sudo -n mkdir -m 0750 \"\$BACKUP\"
sudo -n touch \"\$BACKUP/backup.incomplete\"
if sudo -n test -f \"\$CONF\"; then sudo -n cp -p \"\$CONF\" \"\$BACKUP/httpd.conf\"; fi
if sudo -n test -f \"\$ROTATE\"; then sudo -n cp -p \"\$ROTATE\" \"\$BACKUP/logrotate.conf\"; fi
if sudo -n test -f \"\$SAMPLE\"; then sudo -n cp -p \"\$SAMPLE\" \"\$BACKUP/sample.sh\"; fi
if sudo -n test -f \"\$HOOK\"; then sudo -n cp -p \"\$HOOK\" \"\$BACKUP/rotation.sh\"; fi
if sudo -n test -f \"\$SERVICE\"; then sudo -n cp -p \"\$SERVICE\" \"\$BACKUP/monitor.service\"; fi
if sudo -n test -f \"\$TIMER\"; then sudo -n cp -p \"\$TIMER\" \"\$BACKUP/monitor.timer\"; fi
if sudo -n test -f \"\$VALID\"; then sudo -n cp -p \"\$VALID\" \"\$BACKUP/valid-since\"; fi
if sudo -n test -f \"\$PRODUCER\"; then sudo -n cp -p \"\$PRODUCER\" \"\$BACKUP/producer-version\"; fi
if systemctl is-enabled ops-toolkit-http-metrics-monitor.timer >/dev/null 2>&1; then sudo -n touch \"\$BACKUP/timer.enabled\"; fi
if systemctl is-active --quiet ops-toolkit-http-metrics-monitor.timer; then sudo -n touch \"\$BACKUP/timer.active\"; fi
sudo -n touch \"\$BACKUP/timer.state-recorded\"
sudo -n rm \"\$BACKUP/backup.incomplete\"
BACKUP_READY=1
if sudo -n test -f \"\$TIMER\"; then sudo -n systemctl stop ops-toolkit-http-metrics-monitor.timer; fi
if sudo -n test -f \"\$SERVICE\"; then sudo -n systemctl stop ops-toolkit-http-metrics-monitor.service; fi
sudo -n install -o root -g root -m 0644 \"\$SOURCE/httpd.conf\" \"\$CONF\"
sudo -n grep -F '/usr/sbin/rotatelogs -f -n 2 -L /var/log/httpd/ops-toolkit-request-metrics.metrics' \"\$CONF\" >/dev/null
sudo -n apachectl configtest
sudo -n install -d -o root -g root -m 0755 /usr/local/libexec
sudo -n install -o root -g root -m 0755 \"\$SOURCE/sample.sh\" \"\$SAMPLE\"
sudo -n install -o root -g root -m 0755 \"\$SOURCE/rotation.sh\" \"\$HOOK\"
sudo -n install -o root -g root -m 0644 \"\$SOURCE/logrotate.conf\" \"\$ROTATE\"
sudo -n install -o root -g root -m 0644 \"\$SOURCE/monitor.service\" \"\$SERVICE\"
sudo -n install -o root -g root -m 0644 \"\$SOURCE/monitor.timer\" \"\$TIMER\"
sudo -n touch /var/log/httpd/ops-toolkit-request-metrics.ring /var/log/httpd/ops-toolkit-request-metrics.ring.1
sudo -n chmod 0640 /var/log/httpd/ops-toolkit-request-metrics.ring /var/log/httpd/ops-toolkit-request-metrics.ring.1
sudo -n touch /var/log/httpd/ops-toolkit-request-metrics.metrics
sudo -n chmod 0640 /var/log/httpd/ops-toolkit-request-metrics.metrics
sudo -n logrotate --debug /etc/logrotate.conf >/dev/null
if ! sudo -n grep -qx http-filtered-v1 \"\$BACKUP/producer-version\" 2>/dev/null || ! sudo -n test -f \"\$VALID\" || ! sudo -n grep -F 'env=!ops_toolkit_internal_monitor' \"\$BACKUP/httpd.conf\" >/dev/null 2>&1; then
  date -u +%Y-%m-%dT%H:%M:%SZ | sudo -n tee \"\$VALID\" >/dev/null
fi
sudo -n chmod 0640 \"\$VALID\"
sudo -n systemctl daemon-reload
sudo -n systemctl reload httpd
sudo -n systemctl start ops-toolkit-http-metrics-monitor.service
printf 'http-filtered-v1\n' | sudo -n tee \"\$PRODUCER\" >/dev/null
sudo -n chmod 0640 \"\$PRODUCER\"
sudo -n systemctl enable --now ops-toolkit-http-metrics-monitor.timer >/dev/null
systemctl is-active httpd; systemctl is-active ops-toolkit-http-metrics-monitor.timer; systemctl is-enabled ops-toolkit-http-metrics-monitor.timer
printf 'action=%s\nbackup=%s\nhistory=/var/lib/ops-toolkit/http-history\n' \"\$ACTION\" \"\$BACKUP\"
trap - EXIT"
