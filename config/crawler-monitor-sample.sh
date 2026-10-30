#!/usr/bin/env bash
set -euo pipefail

history_dir=/var/lib/ops-toolkit/crawler-history
interval_seconds=${CRAWLER_MONITOR_INTERVAL_SECONDS:-300}
root_pattern=${CRAWLER_MONITOR_ROOT_PATTERN:-^(run_day_session|day_session_loo)$}

sample() {
  local timestamp date_file memory_total memory_available swap_total swap_free swap_used
  local load_1m root_used pid status name rss child
  local process_count=0 rss_sum=0 rss_max=0
  local -a queue=()
  declare -A seen=()

  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  date_file="$history_dir/$(date -u +%Y-%m-%d).tsv"
  memory_total=$(awk '$1 == "MemTotal:" { print $2 }' /proc/meminfo)
  memory_available=$(awk '$1 == "MemAvailable:" { print $2 }' /proc/meminfo)
  swap_total=$(awk '$1 == "SwapTotal:" { print $2 }' /proc/meminfo)
  swap_free=$(awk '$1 == "SwapFree:" { print $2 }' /proc/meminfo)
  swap_used=$((swap_total - swap_free))
  load_1m=$(awk '{ print $1 }' /proc/loadavg)
  root_used=$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')

  for status in /proc/[0-9]*/status; do
    [[ -r "$status" ]] || continue
    pid=${status#/proc/}
    pid=${pid%/status}
    name=$(awk '$1 == "Name:" { print $2 }' "$status" 2>/dev/null || true)
    [[ "$name" =~ $root_pattern ]] && queue+=("$pid")
  done

  while ((${#queue[@]} > 0)); do
    pid=${queue[0]}
    queue=("${queue[@]:1}")
    [[ -z "${seen[$pid]:-}" ]] || continue
    seen[$pid]=1
    status="/proc/$pid/status"
    [[ -r "$status" ]] || continue
    rss=$(awk '$1 == "VmRSS:" { print $2 }' "$status" 2>/dev/null || true)
    [[ "$rss" =~ ^[0-9]+$ ]] || rss=0
    process_count=$((process_count + 1))
    rss_sum=$((rss_sum + rss))
    ((rss > rss_max)) && rss_max=$rss
    if [[ -r "/proc/$pid/task/$pid/children" ]]; then
      for child in $(<"/proc/$pid/task/$pid/children"); do
        [[ "$child" =~ ^[0-9]+$ ]] && queue+=("$child")
      done
    fi
  done

  if [[ ! -e "$date_file" ]]; then
    printf 'timestamp\tmem_total_kb\tmem_available_kb\tswap_used_kb\tload_1m\troot_used_percent\tcrawler_process_count\tcrawler_rss_sum_kb\tcrawler_rss_max_kb\n' > "$date_file"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$timestamp" "$memory_total" "$memory_available" "$swap_used" "$load_1m" "$root_used" \
    "$process_count" "$rss_sum" "$rss_max" >> "$date_file"
  find "$history_dir" -maxdepth 1 -type f -name '*.tsv' -mtime +35 -delete
}

mkdir -p "$history_dir"
if [[ "${1:-}" == "--once" ]]; then
  sample
  exit 0
fi

while true; do
  sample || true
  sleep "$interval_seconds"
done
