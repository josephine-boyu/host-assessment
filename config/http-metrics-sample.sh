#!/usr/bin/env bash
set -euo pipefail

umask 0027

log_file=${HTTP_METRICS_LOG_FILE:-/var/log/httpd/ops-toolkit-request-metrics.metrics}
history_dir=${HTTP_METRICS_HISTORY_DIR:-/var/lib/ops-toolkit/http-history}
state_file=${HTTP_METRICS_STATE_FILE:-$history_dir/cursor}
retention_days=${HTTP_METRICS_RETENTION_DAYS:-35}

[[ "$retention_days" =~ ^[0-9]+$ ]] && ((retention_days >= 1 && retention_days <= 365)) || {
  printf '%s\n' 'HTTP_METRICS_RETENTION_DAYS must be 1..365' >&2
  exit 2
}

mkdir -p "$history_dir"
[[ -r "$log_file" ]] || { printf 'HTTP metrics log is not readable: %s\n' "$log_file" >&2; exit 1; }
inode=$(stat -c '%i' "$log_file")
size=$(stat -c '%s' "$log_file")
previous_inode=""
offset=0
if [[ -r "$state_file" ]]; then
  read -r previous_inode offset < "$state_file" || true
fi
[[ "$offset" =~ ^[0-9]+$ ]] || offset=0
if [[ "$previous_inode" != "$inode" ]] || ((size < offset)); then
  offset=0
fi

# Bound work even after downtime or a traffic burst. A skipped batch cannot be
# used as evidence of low load: retain a gap marker for the observation window.
find "$history_dir" -maxdepth 1 -type f -name '*.gaps' -mtime "+$retention_days" -delete
if ((size - offset > 1048576)); then
  date -u +%Y-%m-%dT%H:%M:%SZ >> "$history_dir/$(date -u +%Y-%m-%d).gaps"
  printf '%s %s\n' "$inode" "$size" > "$state_file"
  printf '%s\n' 'HTTP batch exceeds 1 MiB; skipped and marked as an evidence gap' >&2
  exit 1
fi

chunk=$(mktemp)
durations=$(mktemp)
sorted=$(mktemp)
trap 'rm -f "$chunk" "$durations" "$sorted" "$chunk.complete"' EXIT
if ((size > offset)); then
  dd if="$log_file" of="$chunk" iflag=skip_bytes,count_bytes skip="$offset" count="$((size - offset))" status=none
else
  : > "$chunk"
fi
# A piped logger may end a write buffer in the middle of a record. Keep that
# tail behind the cursor until its terminating newline arrives.
if [[ -s "$chunk" && -n "$(tail -c 1 "$chunk")" ]]; then
  sed '$d' "$chunk" > "$chunk.complete"
  mv "$chunk.complete" "$chunk"
fi
next_offset=$((offset + $(wc -c < "$chunk")))

summary=$(awk -v durations="$durations" '
  $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9][0-9][0-9]$/ && $3 ~ /^[0-9]+$/ && $2 >= 100 && $2 <= 599 {
    n++; code=int($2); duration=$3+0; print duration > durations
    if (code < 300) c2++; else if (code < 400) c3++; else if (code < 500) c4++; else c5++
    if (duration > max) max=duration
  }
  END { printf "%d %d %d %d %d %.0f", n, c2, c3, c4, c5, max }
' "$chunk")
read -r requests status_2xx status_3xx status_4xx status_5xx latency_max_us <<<"$summary"

latency_p50_us=0
latency_p95_us=0
latency_p99_us=0
if ((requests > 0)); then
  sort -S 1M -n "$durations" > "$sorted"
  p50_index=$(((requests * 50 + 99) / 100))
  p95_index=$(((requests * 95 + 99) / 100))
  p99_index=$(((requests * 99 + 99) / 100))
  read -r latency_p50_us latency_p95_us latency_p99_us < <(awk -v p50="$p50_index" -v p95="$p95_index" -v p99="$p99_index" '
    NR == p50 { v50=$1 }
    NR == p95 { v95=$1 }
    NR == p99 { v99=$1 }
    END { printf "%.0f %.0f %.0f\n", v50, v95, v99 }
  ' "$sorted")
fi

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
date_file="$history_dir/$(date -u +%Y-%m-%d).tsv"
if [[ ! -e "$date_file" ]]; then
  printf '%s\n' 'timestamp	requests	status_2xx	status_3xx	status_4xx	status_5xx	latency_p50_us	latency_p95_us	latency_p99_us	latency_max_us' > "$date_file"
fi
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$timestamp" "$requests" "$status_2xx" "$status_3xx" "$status_4xx" "$status_5xx" \
  "$latency_p50_us" "$latency_p95_us" "$latency_p99_us" "$latency_max_us" >> "$date_file"
printf '%s %s\n' "$inode" "$next_offset" > "$state_file"
find "$history_dir" -maxdepth 1 -type f -name '*.tsv' -mtime "+$retention_days" -delete
