#!/usr/bin/env bash
# Sourced by the SSH collector and --summary wrappers; no remote installation.
set -euo pipefail

monitor_summary() {
  local kind=$1 days=$2 directory cutoff end valid_since
  [[ "$kind" == php || "$kind" == http ]] || return 2
  [[ "$days" =~ ^[0-9]+$ ]] && ((days >= 1 && days <= 35)) || return 2
  directory=${MONITOR_HISTORY_DIR:-/var/lib/ops-toolkit/php-fpm-history}
  if [[ "$kind" == http ]]; then directory=${MONITOR_HISTORY_DIR:-/var/lib/ops-toolkit/http-history}; fi
  end=${MONITOR_WINDOW_END:-$(date -u +%Y-%m-%dT00:00:00Z)}
  cutoff=${MONITOR_WINDOW_START:-$(date -u -d "$end -$days days" +%Y-%m-%dT%H:%M:%SZ)}
  # Explicit boundaries arrive normalized by the Node CLI; direct callers also fail closed.
  [[ "$cutoff" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z$ && "$end" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z$ ]] || return 2
  local start_epoch end_epoch
  start_epoch=$(date -u -d "$cutoff" +%s); end_epoch=$(date -u -d "$end" +%s)
  ((end_epoch > start_epoch && end_epoch - start_epoch <= 35*86400)) || return 2
  valid_since=$(sudo -n cat "$directory/valid-since" 2>/dev/null || true)
  if [[ "$kind" == http ]]; then
    local producer valid_normalized
    valid_since=$(sudo -n cat "$directory/valid-since" 2>/dev/null) || valid_since=""
    producer=$(sudo -n cat "$directory/producer-version" 2>/dev/null) || producer=""
    valid_normalized=$(date -u -d "$valid_since" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || valid_normalized=""
    if [[ "$producer" != http-filtered-v1 || ! "$valid_since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ || "$valid_normalized" != "$valid_since" ]]; then
      printf 'available=false\ncompatibility=unknown_or_unsupported\n'; return 0
    fi
    printf 'producer_version=%s\nvalid_since=%s\n' "$producer" "$valid_since"
  fi
  local -a files=()
  mapfile -d '' -t files < <(sudo -n find "$directory" -maxdepth 1 -type f -name '*.tsv' -print0 2>/dev/null)
  ((${#files[@]})) || { printf 'available=false\n'; return 0; }
  local gap_count=0
  if [[ "$kind" == http ]]; then
    local -a gap_files=()
    # Capture exit status: process substitution would hide find/permission errors.
    local gap_listing
    if ! gap_listing=$(sudo -n find "$directory" -maxdepth 1 -type f -name '*.gaps' -print 2>/dev/null); then
      printf 'available=false\ncompatibility=gap_inventory_unreadable\n'; return 0
    fi
    if [[ -n "$gap_listing" ]]; then mapfile -t gap_files <<< "$gap_listing"; fi
    if ((${#gap_files[@]})); then
      if ! gap_count=$(sudo -n cat -- "${gap_files[@]}" | awk -v start="$cutoff" -v end="$end" '$0 >= start && $0 < end { n++ } END { print n+0 }'); then
        printf 'available=false\ncompatibility=gap_history_unreadable\n'; return 0
      fi
    fi
    printf 'collection_gap_count=%s\n' "$gap_count"
  fi
  # Sorting rows (not filenames) makes counters deterministic across rotated files.
  sudo -n cat -- "${files[@]}" | LC_ALL=C sort -t $'\t' -k1,1 | TZ=UTC awk -F '\t' -v kind="$kind" -v cutoff="$cutoff" -v end="$end" -v days="$days" -v explicit="${MONITOR_WINDOW_START:-}" -v valid_since="$valid_since" '
  function epoch(s, a) { split(s,a,/[-T:Z]/); return mktime(a[1] " " a[2] " " a[3] " " a[4] " " a[5] " " a[6]) }
  function out(k,v) { printf "%s=%s\n",k,v }
  BEGIN { start=epoch(cutoff); finish=epoch(end); expected=(finish-start)/60; pss_expected=int((expected+4)/5); prev_time=start; }
  $1 == "timestamp" { next }
  $1 < cutoff { prior_http_time=$1; next }
  $1 >= cutoff && $1 < end && (valid_since == "" || $1 >= valid_since) {
    if (seen[$1]++) { duplicates++; if (previous_row != $0) conflicts++; next }
    previous_row=$0
    if (NF != (kind == "php" ? 20 : 10) || $1 !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/) { invalid++; next }
    for (i=2;i<=NF;i++) if ($i !~ /^[0-9]+([.][0-9]+)?$/) { invalid++; next }
    # HTTP rows summarize the preceding cursor interval. Drop the crossing batch.
    if (kind=="http" && explicit!="") {
      prior=prior_http_time; prior_http_time=$1
      if (prior=="" || prior<cutoff) { boundary_excluded++; next }
    }
    t=epoch($1); slot=int((t-start)/60); if (!slots[slot]++) covered++
    gap=t-prev_time; if (gap>max_gap) max_gap=gap; prev_time=t
    n++
    if (kind == "php") {
      if ($3>queue) queue=$3; if ($4>queue_seen) queue_seen=$4
      if ($7>active) active=$7; if ($8>total) total=$8; if ($9>active_seen) active_seen=$9
      if (n>1) {
        reset=($12<prev_age || $2<prev_conn || $10<prev_children || $11<prev_slow)
        if (reset) resets++
        children_delta += reset ? $10 : $10-prev_children
        slow_delta += reset ? $11 : $11-prev_slow
      }
      prev_age=$12; prev_conn=$2; prev_children=$10; prev_slow=$11
      if ($10>children) children=$10; if ($11>slow) slow=$11
      if ($14>rss_sum) rss_sum=$14; if ($15>rss_one) rss_one=$15
      if ($16>0) { pss_samples++; if (!pss_slots[int(slot/5)]++) pss_covered++; if ($17>pss_sum) pss_sum=$17; if ($18>pss_one) pss_one=$18 }
      if (n==1 || $19<mem) mem=$19; if ($20>swap) swap=$20
    } else {
      requests+=$2; c2+=$3; c3+=$4; c4+=$5; c5+=$6
      if ($2>0) active_minutes++
      if ($8>p95) p95=$8; if ($9>p99) p99=$9; if ($10>latency) latency=$10
      if ($2>=20) eligible++
      if ($2>=20 && $8>=3000000) {
        slow_minutes++
        if (!slow_slots[slot]++) {
          if (last_slow_slot==slot-1) streak++; else streak=1
          last_slow_slot=slot; if (streak>max_streak) max_streak=streak
        }
      }
    }
  }
  END {
    if (finish-prev_time>max_gap) max_gap=finish-prev_time
    out("available", n ? "true" : "false"); out("summary_version",2)
    out("window_start",cutoff); out("window_end",end); out("window_days",(finish-start)/86400)
    out("samples",n+0); out("covered_slots",covered+0); out("expected_slots",expected)
    out("coverage",expected ? covered/expected : 0); out("max_sample_gap_seconds",max_gap)
    out("duplicate_samples",duplicates+0); out("conflicting_samples",conflicts+0); out("invalid_samples",invalid+0)
    if (kind=="php") {
      out("counter_resets",resets+0); out("listen_queue_max",queue+0); out("max_listen_queue_seen",queue_seen+0)
      out("active_processes_max",active+0); out("total_processes_max",total+0); out("max_active_processes_seen",active_seen+0)
      out("max_children_reached_counter_max",children+0); out("max_children_reached_delta",children_delta+0)
      out("slow_requests_counter_max",slow+0); out("slow_requests_delta",slow_delta+0)
      out("worker_rss_sum_max_mb",rss_sum/1024); out("worker_rss_one_max_mb",rss_one/1024)
      out("worker_pss_available_samples",pss_samples+0); out("pss_covered_slots",pss_covered+0); out("pss_expected_slots",pss_expected)
      out("pss_coverage",pss_expected ? pss_covered/pss_expected : 0)
      out("worker_pss_sum_max_mb",pss_sum/1024); out("worker_pss_one_max_mb",pss_one/1024)
      out("memory_available_min_mb",mem/1024); out("swap_used_max_mb",swap/1024)
    } else {
      out("active_minutes",active_minutes+0); out("requests",requests+0)
      out("status_2xx",c2+0); out("status_3xx",c3+0); out("status_4xx",c4+0); out("status_5xx",c5+0)
      out("status_5xx_rate_percent",requests ? c5*100/requests : 0)
      out("latency_p95_peak_ms",p95/1000); out("latency_p99_peak_ms",p99/1000); out("latency_max_ms",latency/1000)
      out("latency_eligible_samples",eligible+0); out("latency_slow_samples",slow_minutes+0)
      out("latency_slow_consecutive_slots",max_streak+0)
      out("latency_threshold_ms",3000); out("latency_min_requests",20)
      out("boundary_samples_excluded",boundary_excluded+0)
    }
  }'
}
