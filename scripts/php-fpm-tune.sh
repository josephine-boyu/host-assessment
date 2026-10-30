#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/php-fpm-tune.sh --check <ssh-alias>
  scripts/php-fpm-tune.sh --apply <ssh-alias>
  scripts/php-fpm-tune.sh --rollback <ssh-alias> <remote-backup-path>

Applies the low-traffic 2 GiB PHP-FPM candidate:
  pm=ondemand, max_children=4, process_idle_timeout=10s, max_requests=300

Environment:
  SSH_COMMAND   ssh executable (default: ssh)
  SSH_CONFIG    optional SSH config path

The remote account must support passwordless sudo. Apply creates a timestamped
backup under /var/backups/ops-toolkit/php-fpm/ and validates php-fpm before reload.
EOF
}

[[ $# -ge 2 ]] || { usage; exit 2; }
mode=$1
target=$2
[[ "$mode" == "--check" || "$mode" == "--apply" || "$mode" == "--rollback" ]] || { usage; exit 2; }
if [[ "$mode" == "--rollback" ]]; then
  [[ $# -eq 3 ]] || { usage; exit 2; }
else
  [[ $# -eq 2 ]] || { usage; exit 2; }
fi

ssh_bin=${SSH_COMMAND:-ssh}
ssh_args=(-o BatchMode=yes -o ConnectTimeout=8)
if [[ -n "${SSH_CONFIG:-}" ]]; then
  ssh_args=(-F "$SSH_CONFIG" "${ssh_args[@]}")
fi

read_command='set -eu; POOL=/etc/php-fpm.d/www.conf; sudo -n test -f "$POOL"; systemctl is-active php-fpm; sudo -n grep -E "^[[:space:]]*(pm|pm[.]max_children|pm[.]process_idle_timeout|pm[.]max_requests|request_slowlog_timeout|slowlog|php_admin_value\[memory_limit\])[[:space:]]*=" "$POOL" || true'

if [[ "$mode" == "--check" ]]; then
  "$ssh_bin" "${ssh_args[@]}" "$target" "$read_command"
  exit 0
fi

if [[ "$mode" == "--rollback" ]]; then
  backup=$3
  [[ "$backup" =~ ^/var/backups/ops-toolkit/php-fpm/www\.conf\.[0-9]{8}T[0-9]{6}Z$ ]] || {
    echo "Invalid backup path: $backup" >&2
    exit 2
  }
  rollback_command="set -euo pipefail; POOL=/etc/php-fpm.d/www.conf; BACKUP='$backup'; sudo -n test -f \"\$BACKUP\"; TEMP=\$(mktemp); trap 'rm -f \"\$TEMP\"' EXIT; sudo -n cp \"\$BACKUP\" \"\$TEMP\"; sudo -n install -o root -g root -m 0644 \"\$TEMP\" \"\$POOL\"; if ! sudo -n php-fpm -t; then sudo -n cp \"\$BACKUP\" \"\$POOL\"; exit 1; fi; sudo -n systemctl reload php-fpm; systemctl is-active php-fpm; echo rollback=\"\$BACKUP\""
  "$ssh_bin" "${ssh_args[@]}" "$target" "$rollback_command"
  exit 0
fi

apply_command='set -euo pipefail
POOL=/etc/php-fpm.d/www.conf
BACKUP_DIR=/var/backups/ops-toolkit/php-fpm
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$BACKUP_DIR/www.conf.$STAMP"
TEMP=$(mktemp)
trap '\''rm -f "$TEMP"'\'' EXIT
sudo -n test -f "$POOL"
sudo -n install -d -o root -g root -m 0750 "$BACKUP_DIR"
sudo -n cp -p "$POOL" "$BACKUP"
sudo -n sed -E \
  -e '\''s/^[[:space:]]*pm[[:space:]]*=.*/pm = ondemand/'\'' \
  -e '\''s/^[[:space:]]*pm[.]max_children[[:space:]]*=.*/pm.max_children = 4/'\'' \
  -e '\''s/^[;[:space:]]*pm[.]process_idle_timeout[[:space:]]*=.*/pm.process_idle_timeout = 10s/'\'' \
  -e '\''s/^[[:space:]]*pm[.]max_requests[[:space:]]*=.*/pm.max_requests = 300/'\'' \
  "$POOL" > "$TEMP"
for expected in "pm = ondemand" "pm.max_children = 4" "pm.process_idle_timeout = 10s" "pm.max_requests = 300"; do
  test "$(grep -Fxc "$expected" "$TEMP")" -eq 1 || { echo "Expected exactly one: $expected" >&2; exit 1; }
done
sudo -n install -o root -g root -m 0644 "$TEMP" "$POOL"
if ! sudo -n php-fpm -t; then
  sudo -n cp -p "$BACKUP" "$POOL"
  echo "Validation failed; restored $BACKUP" >&2
  exit 1
fi
sudo -n systemctl reload php-fpm
systemctl is-active php-fpm
echo "backup=$BACKUP"
sudo -n grep -E "^[[:space:]]*(pm|pm[.]max_children|pm[.]process_idle_timeout|pm[.]max_requests|request_slowlog_timeout|slowlog|php_admin_value\[memory_limit\])[[:space:]]*=" "$POOL" || true'

"$ssh_bin" "${ssh_args[@]}" "$target" "$apply_command"
