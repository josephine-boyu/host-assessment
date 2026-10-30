#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/disk-write-audit.sh <ssh-alias>

Environment:
  SSH_COMMAND   ssh executable (default: ssh)
  SSH_CONFIG    optional SSH config path

Read-only audit of filesystem usage, recent large files, logs, deleted-open
files and per-process cumulative write_bytes. Remote scans have time limits.
EOF
}

[[ $# -eq 1 ]] || { usage; exit 2; }
target=$1
ssh_bin=${SSH_COMMAND:-ssh}
ssh_args=(-o BatchMode=yes -o ConnectTimeout=8)
if [[ -n "${SSH_CONFIG:-}" ]]; then
  ssh_args=(-F "$SSH_CONFIG" "${ssh_args[@]}")
fi

"$ssh_bin" "${ssh_args[@]}" "$target" 'sudo -n bash -s' <<'REMOTE'
set -u

section() {
  printf '\n## %s\n' "$1"
}

section "system"
date -u +"collected_at=%Y-%m-%dT%H:%M:%SZ"
uptime

section "filesystem"
df -hT -x tmpfs -x devtmpfs
df -i -x tmpfs -x devtmpfs

section "journal"
journalctl --disk-usage 2>&1 || true
printf 'entries_last_24h='
journalctl --since '24 hours ago' --no-pager -o json 2>/dev/null | wc -l || true
echo "top_systemd_units_last_24h:"
journalctl --since '24 hours ago' --no-pager -o json 2>/dev/null \
  | sed -nE 's/.*"_SYSTEMD_UNIT":"([^"]*)".*/\1/p' \
  | sort | uniq -c | sort -nr | head -n 15 || true
echo "top_syslog_identifiers_last_24h:"
journalctl --since '24 hours ago' --no-pager -o json 2>/dev/null \
  | sed -nE 's/.*"SYSLOG_IDENTIFIER":"([^"]*)".*/\1/p' \
  | sort | uniq -c | sort -nr | head -n 15 || true

section "top-level directory bytes"
for path in /var /home /opt /tmp; do
  [[ -e "$path" ]] || continue
  timeout 30 du -x -B1 -d1 "$path" 2>/dev/null | sort -nr | head -n 20 || true
done

section "log directory bytes"
timeout 20 du -x -B1 -d2 /var/log 2>/dev/null | sort -nr | head -n 30 || true

section "large files modified within 3 days"
for path in /var /home /opt /tmp; do
  [[ -e "$path" ]] || continue
  timeout 20 find "$path" -xdev -type f -mtime -3 -printf '%s\t%TY-%Tm-%TdT%TH:%TM:%TS\t%p\n' 2>/dev/null || true
done | sort -nr | head -n 50

section "process cumulative write bytes"
for io in /proc/[0-9]*/io; do
  [[ -r "$io" ]] || continue
  pid=${io#/proc/}
  pid=${pid%/io}
  bytes=$(awk '$1 == "write_bytes:" { print $2 }' "$io" 2>/dev/null || true)
  [[ "$bytes" =~ ^[0-9]+$ ]] || continue
  comm=$(tr -d '\n' < "/proc/$pid/comm" 2>/dev/null || printf unknown)
  printf '%s\t%s\t%s\n' "$bytes" "$pid" "$comm"
done | sort -nr | head -n 30

section "deleted but open files"
if command -v lsof >/dev/null 2>&1; then
  timeout 15 lsof -nP +L1 2>/dev/null | head -n 30 || true
else
  echo "lsof unavailable"
fi
REMOTE
