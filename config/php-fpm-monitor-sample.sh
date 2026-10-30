#!/usr/bin/env bash
set -euo pipefail

umask 0027

history_dir=${PHP_FPM_MONITOR_HISTORY_DIR:-/var/lib/ops-toolkit/php-fpm-history}
status_url=${PHP_FPM_MONITOR_STATUS_URL:-http://127.0.0.1:9081/ops-toolkit-fpm-status?json}
status_file=${PHP_FPM_MONITOR_STATUS_FILE:-}
proc_root=${PHP_FPM_MONITOR_PROC_ROOT:-/proc}
retention_days=${PHP_FPM_MONITOR_RETENTION_DAYS:-35}
pss_mode=${PHP_FPM_MONITOR_PSS_MODE:-auto}

[[ "$retention_days" =~ ^[0-9]+$ ]] && ((retention_days >= 1 && retention_days <= 365)) || {
  printf '%s\n' 'PHP_FPM_MONITOR_RETENTION_DAYS must be 1..365' >&2
  exit 2
}
[[ "$pss_mode" == "auto" || "$pss_mode" == "always" || "$pss_mode" == "never" ]] || {
  printf '%s\n' 'PHP_FPM_MONITOR_PSS_MODE must be auto, always or never' >&2
  exit 2
}

collect_pss=false
if [[ "$pss_mode" == "always" ]]; then
  collect_pss=true
elif [[ "$pss_mode" == "auto" ]]; then
  minute=$(date -u +%M)
  if ((10#$minute % 5 == 0)); then
    collect_pss=true
  fi
fi

mkdir -p "$history_dir"

if [[ -n "$status_file" ]]; then
  status_json=$(<"$status_file")
else
  status_json=$(curl --fail --silent --show-error --max-time 2 "$status_url")
fi

read_status_number() {
  local field=$1
  jq -er --arg field "$field" '.[$field] | numbers' <<<"$status_json"
}

accepted_conn=$(read_status_number 'accepted conn')
listen_queue=$(read_status_number 'listen queue')
max_listen_queue=$(read_status_number 'max listen queue')
listen_queue_len=$(read_status_number 'listen queue len')
idle_processes=$(read_status_number 'idle processes')
active_processes=$(read_status_number 'active processes')
total_processes=$(read_status_number 'total processes')
max_active_processes=$(read_status_number 'max active processes')
max_children_reached=$(read_status_number 'max children reached')
slow_requests=$(read_status_number 'slow requests')
start_since=$(read_status_number 'start since')

worker_count=0
worker_rss_sum_kb=0
worker_rss_max_kb=0
worker_pss_sum_kb=0
worker_pss_max_kb=0
worker_pss_samples=0

for status_path in "$proc_root"/[0-9]*/status; do
  [[ -r "$status_path" ]] || continue
  pid_dir=${status_path%/status}
  name=$(awk '$1 == "Name:" { print $2; exit }' "$status_path" 2>/dev/null || true)
  [[ "$name" == php-fpm* ]] || continue
  command_line=$(tr '\0' ' ' < "$pid_dir/cmdline" 2>/dev/null || true)
  [[ "$command_line" != *'master process'* ]] || continue

  rss_kb=$(awk '$1 == "VmRSS:" { print $2; exit }' "$status_path" 2>/dev/null || true)
  [[ "$rss_kb" =~ ^[0-9]+$ ]] || rss_kb=0
  worker_count=$((worker_count + 1))
  worker_rss_sum_kb=$((worker_rss_sum_kb + rss_kb))
  ((rss_kb > worker_rss_max_kb)) && worker_rss_max_kb=$rss_kb

  if [[ "$collect_pss" == true ]]; then
    pss_kb=$(awk '$1 == "Pss:" { print $2; exit }' "$pid_dir/smaps_rollup" 2>/dev/null || true)
    if [[ "$pss_kb" =~ ^[0-9]+$ ]]; then
      worker_pss_samples=$((worker_pss_samples + 1))
      worker_pss_sum_kb=$((worker_pss_sum_kb + pss_kb))
      ((pss_kb > worker_pss_max_kb)) && worker_pss_max_kb=$pss_kb
    fi
  fi
done

memory_available_kb=$(awk '$1 == "MemAvailable:" { print $2; exit }' "$proc_root/meminfo" 2>/dev/null || true)
swap_total_kb=$(awk '$1 == "SwapTotal:" { print $2; exit }' "$proc_root/meminfo" 2>/dev/null || true)
swap_free_kb=$(awk '$1 == "SwapFree:" { print $2; exit }' "$proc_root/meminfo" 2>/dev/null || true)
[[ "$memory_available_kb" =~ ^[0-9]+$ ]] || memory_available_kb=0
[[ "$swap_total_kb" =~ ^[0-9]+$ ]] || swap_total_kb=0
[[ "$swap_free_kb" =~ ^[0-9]+$ ]] || swap_free_kb=0
swap_used_kb=$((swap_total_kb - swap_free_kb))

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
date_file="$history_dir/$(date -u +%Y-%m-%d).tsv"
if [[ ! -e "$date_file" ]]; then
  printf '%s\n' 'timestamp	accepted_conn	listen_queue	max_listen_queue	listen_queue_len	idle_processes	active_processes	total_processes	max_active_processes	max_children_reached	slow_requests	start_since	worker_count	worker_rss_sum_kb	worker_rss_max_kb	worker_pss_samples	worker_pss_sum_kb	worker_pss_max_kb	memory_available_kb	swap_used_kb' > "$date_file"
fi
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$timestamp" "$accepted_conn" "$listen_queue" "$max_listen_queue" "$listen_queue_len" \
  "$idle_processes" "$active_processes" "$total_processes" "$max_active_processes" \
  "$max_children_reached" "$slow_requests" "$start_since" "$worker_count" \
  "$worker_rss_sum_kb" "$worker_rss_max_kb" "$worker_pss_samples" "$worker_pss_sum_kb" \
  "$worker_pss_max_kb" "$memory_available_kb" "$swap_used_kb" >> "$date_file"

find "$history_dir" -maxdepth 1 -type f -name '*.tsv' -mtime "+$retention_days" -delete
