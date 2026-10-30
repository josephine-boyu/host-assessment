#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/php-fpm-monitor.sh --check <ssh-alias>
  scripts/php-fpm-monitor.sh --apply <ssh-alias>
  scripts/php-fpm-monitor.sh --summary <ssh-alias> [days]
  scripts/php-fpm-monitor.sh --rollback <ssh-alias> <remote-backup-directory>

Environment:
  SSH_COMMAND   ssh executable (default: ssh)
  SCP_COMMAND   scp executable (default: scp)
  SSH_CONFIG    optional SSH config path

The monitor uses a loopback-only Apache listener and PHP-FPM's brief JSON status.
It never requests the privacy-sensitive full status page. Apply changes PHP-FPM
and Apache configuration, validates both, reloads them, then installs a hardened
one-shot systemd timer. Rollback restores the recorded configuration backup.
EOF
}

[[ $# -ge 2 ]] || { usage; exit 2; }
mode=$1
target=$2
[[ "$mode" == "--check" || "$mode" == "--apply" || "$mode" == "--summary" || "$mode" == "--rollback" ]] || { usage; exit 2; }
if [[ "$mode" == "--summary" ]]; then
  [[ $# -le 3 ]] || { usage; exit 2; }
elif [[ "$mode" == "--rollback" ]]; then
  [[ $# -eq 3 ]] || { usage; exit 2; }
else
  [[ $# -eq 2 ]] || { usage; exit 2; }
fi

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
POOL=/etc/php-fpm.d/www.conf
sudo -n true
sudo -n test -f "$POOL"
command -v bash >/dev/null
command -v curl >/dev/null
command -v jq >/dev/null
command -v awk >/dev/null
command -v find >/dev/null
command -v apachectl >/dev/null
sudo -n httpd -M 2>/dev/null | grep env_module >/dev/null
systemctl is-active php-fpm >/dev/null
systemctl is-active httpd >/dev/null
SOCKET=$(sudo -n awk -F= '/^[[:space:]]*listen[[:space:]]*=/ { value=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); print value; exit }' "$POOL")
[[ "$SOCKET" =~ ^/[A-Za-z0-9_./-]+$ ]]
ACTIVE_STATUS=$(sudo -n grep -Ec '^[[:space:]]*pm[.]status_path[[:space:]]*=' "$POOL" || true)
((ACTIVE_STATUS <= 1))
if sudo -n ss -ltnH 'sport = :9081' | grep . >/dev/null && ! sudo -n test -f /etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf; then
  echo "127.0.0.1:9081 is already in use" >&2
  exit 1
fi
if sudo -n test -f /etc/systemd/system/ops-toolkit-php-fpm-monitor.timer; then INSTALLED=yes; else INSTALLED=no; fi
printf 'preflight: ok\nphp_fpm_socket=%s\nactive_status_directives=%s\nmonitor_installed=%s\n' "$SOCKET" "$ACTIVE_STATUS" "$INSTALLED"
REMOTE
)

if [[ "$mode" == "--check" ]]; then
  "$ssh_bin" "${ssh_args[@]}" "$target" "$check_command"
  exit 0
fi

if [[ "$mode" == "--summary" ]]; then
  days=${3:-14}
  [[ "$days" =~ ^[0-9]+$ ]] && ((days >= 1 && days <= 35)) || { printf '%s\n' 'days must be 1..35' >&2; exit 2; }
  summary_script=$(cat "$(dirname -- "${BASH_SOURCE[0]}")/monitor-summary.sh")
  printf '%s\nmonitor_summary php %s\n' "$summary_script" "$days" | "$ssh_bin" "${ssh_args[@]}" "$target" 'bash -s'
  exit 0
fi

if [[ "$mode" == "--rollback" ]]; then
  backup_dir=$3
  [[ "$backup_dir" =~ ^/var/backups/ops-toolkit/php-fpm-monitor/[0-9]{8}T[0-9]{6}Z$ ]] || {
    printf 'Invalid backup directory: %s\n' "$backup_dir" >&2
    exit 2
  }
  rollback_command="set -euo pipefail
BACKUP='$backup_dir'
POOL=/etc/php-fpm.d/www.conf
HTTPD_CONF=/etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf
sudo -n test -f \"\$BACKUP/www.conf\"
sudo -n test ! -e \"\$BACKUP/backup.incomplete\"
sudo -n cp -p \"\$BACKUP/www.conf\" \"\$POOL\"
if sudo -n test -f \"\$BACKUP/httpd.conf\"; then
  sudo -n cp -p \"\$BACKUP/httpd.conf\" \"\$HTTPD_CONF\"
else
  sudo -n rm -f \"\$HTTPD_CONF\"
fi
sudo -n php-fpm -t
sudo -n apachectl configtest
sudo -n systemctl disable --now ops-toolkit-php-fpm-monitor.timer 2>/dev/null || true
sudo -n rm -f /etc/systemd/system/ops-toolkit-php-fpm-monitor.service /etc/systemd/system/ops-toolkit-php-fpm-monitor.timer /usr/local/libexec/ops-toolkit-php-fpm-monitor
sudo -n systemctl daemon-reload
sudo -n systemctl reload php-fpm
sudo -n systemctl reload httpd
systemctl is-active php-fpm
systemctl is-active httpd
printf 'rollback=%s\\nhistory_preserved=/var/lib/ops-toolkit/php-fpm-history\\n' \"\$BACKUP\""
  "$ssh_bin" "${ssh_args[@]}" "$target" "$rollback_command"
  exit 0
fi

"$ssh_bin" "${ssh_args[@]}" "$target" "$check_command"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
remote_tmp=$("$ssh_bin" "${ssh_args[@]}" "$target" 'mktemp -d /tmp/ops-toolkit-php-fpm-monitor.XXXXXX')
[[ "$remote_tmp" =~ ^/tmp/ops-toolkit-php-fpm-monitor[.][A-Za-z0-9]+$ ]] || {
  printf 'Unexpected remote temporary path: %s\n' "$remote_tmp" >&2
  exit 1
}
cleanup_remote() {
  "$ssh_bin" "${ssh_args[@]}" "$target" "rm -rf '$remote_tmp'" >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT

"$scp_bin" "${scp_args[@]}" "$repo_dir/config/php-fpm-monitor-sample.sh" "$target:$remote_tmp/sample.sh"
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/php-fpm-monitor.service" "$target:$remote_tmp/monitor.service"
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/php-fpm-monitor.timer" "$target:$remote_tmp/monitor.timer"
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/php-fpm-monitor-httpd.conf" "$target:$remote_tmp/httpd.conf"

apply_command="set -euo pipefail
SOURCE='$remote_tmp'
POOL=/etc/php-fpm.d/www.conf
HTTPD_CONF=/etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf
sudo -n test ! -e /etc/systemd/system/ops-toolkit-php-fpm-monitor.timer
sudo -n test ! -e /etc/systemd/system/ops-toolkit-php-fpm-monitor.service
sudo -n test ! -e /usr/local/libexec/ops-toolkit-php-fpm-monitor
BACKUP_DIR=/var/backups/ops-toolkit/php-fpm-monitor/\$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_READY=0
POOL_TEMP=\$(mktemp)
HTTPD_TEMP=\$(mktemp)
restore_on_error() {
  status=\$?
  if ((status != 0 && BACKUP_READY == 1)); then
    if sudo -n test -f \"\$BACKUP_DIR/www.conf\"; then
      sudo -n cp -p \"\$BACKUP_DIR/www.conf\" \"\$POOL\" || true
      if sudo -n test -f \"\$BACKUP_DIR/httpd.conf\"; then sudo -n cp -p \"\$BACKUP_DIR/httpd.conf\" \"\$HTTPD_CONF\" || true; else sudo -n rm -f \"\$HTTPD_CONF\" || true; fi
      sudo -n php-fpm -t >/dev/null 2>&1 && sudo -n systemctl reload php-fpm || true
      sudo -n apachectl configtest >/dev/null 2>&1 && sudo -n systemctl reload httpd || true
    fi
    sudo -n systemctl disable --now ops-toolkit-php-fpm-monitor.timer >/dev/null 2>&1 || true
    sudo -n rm -f /etc/systemd/system/ops-toolkit-php-fpm-monitor.service /etc/systemd/system/ops-toolkit-php-fpm-monitor.timer /usr/local/libexec/ops-toolkit-php-fpm-monitor || true
    sudo -n systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f \"\$POOL_TEMP\" \"\$HTTPD_TEMP\"
  exit \$status
}
trap restore_on_error EXIT
SOCKET=\$(sudo -n awk -F= '/^[[:space:]]*listen[[:space:]]*=/ { value=\$2; gsub(/^[[:space:]]+|[[:space:]]+\$/, \"\", value); print value; exit }' \"\$POOL\")
[[ \"\$SOCKET\" =~ ^/[A-Za-z0-9_./-]+\$ ]]
sudo -n install -d -o root -g root -m 0750 /var/backups/ops-toolkit/php-fpm-monitor /var/lib/ops-toolkit/php-fpm-history
sudo -n mkdir -m 0750 \"\$BACKUP_DIR\"
sudo -n touch \"\$BACKUP_DIR/backup.incomplete\"
sudo -n cp -p \"\$POOL\" \"\$BACKUP_DIR/www.conf\"
if sudo -n test -f \"\$HTTPD_CONF\"; then sudo -n cp -p \"\$HTTPD_CONF\" \"\$BACKUP_DIR/httpd.conf\"; fi
sudo -n rm \"\$BACKUP_DIR/backup.incomplete\"
BACKUP_READY=1
sudo -n awk '
  BEGIN { replaced=0 }
  /^[[:space:]]*pm[.]status_path[[:space:]]*=/ { if (replaced++) exit 42; print \"pm.status_path = /ops-toolkit-fpm-status\"; next }
  /^[[:space:]]*;[[:space:]]*pm[.]status_path[[:space:]]*=/ && !replaced { replaced=1; print \"pm.status_path = /ops-toolkit-fpm-status\"; next }
  { print }
  END { if (!replaced) print \"pm.status_path = /ops-toolkit-fpm-status\" }
' \"\$POOL\" > \"\$POOL_TEMP\"
test \"\$(grep -Ec '^[[:space:]]*pm[.]status_path[[:space:]]*=[[:space:]]*/ops-toolkit-fpm-status[[:space:]]*\$' \"\$POOL_TEMP\")\" -eq 1
sed \"s|__PHP_FPM_SOCKET__|\$SOCKET|g\" \"\$SOURCE/httpd.conf\" > \"\$HTTPD_TEMP\"
test \"\$(grep -Fc \"proxy:unix:\$SOCKET|fcgi://localhost\" \"\$HTTPD_TEMP\")\" -eq 1
sudo -n install -o root -g root -m 0644 \"\$POOL_TEMP\" \"\$POOL\"
sudo -n install -o root -g root -m 0644 \"\$HTTPD_TEMP\" \"\$HTTPD_CONF\"
sudo -n php-fpm -t
sudo -n apachectl configtest
sudo -n install -d -o root -g root -m 0755 /usr/local/libexec
sudo -n install -d -o root -g root -m 0750 /var/lib/ops-toolkit/php-fpm-history
sudo -n install -o root -g root -m 0755 \"\$SOURCE/sample.sh\" /usr/local/libexec/ops-toolkit-php-fpm-monitor
sudo -n install -o root -g root -m 0644 \"\$SOURCE/monitor.service\" /etc/systemd/system/ops-toolkit-php-fpm-monitor.service
sudo -n install -o root -g root -m 0644 \"\$SOURCE/monitor.timer\" /etc/systemd/system/ops-toolkit-php-fpm-monitor.timer
sudo -n systemctl daemon-reload
sudo -n systemctl reload php-fpm
sudo -n systemctl reload httpd
curl --fail --silent --show-error --max-time 2 --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:9081/ops-toolkit-fpm-status?json | jq -e 'has(\"active processes\") and has(\"max children reached\")' >/dev/null
sudo -n systemctl start ops-toolkit-php-fpm-monitor.service
sudo -n systemctl enable --now ops-toolkit-php-fpm-monitor.timer >/dev/null
systemctl is-active php-fpm
systemctl is-active httpd
systemctl is-active ops-toolkit-php-fpm-monitor.timer
systemctl is-enabled ops-toolkit-php-fpm-monitor.timer
sudo -n ss -ltnH 'sport = :9081'
printf 'backup=%s\\nhistory=/var/lib/ops-toolkit/php-fpm-history\\n' \"\$BACKUP_DIR\"
trap - EXIT
rm -f \"\$POOL_TEMP\" \"\$HTTPD_TEMP\""

"$ssh_bin" "${ssh_args[@]}" "$target" "$apply_command"
