import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseObservationWindow } from "./observation-window.mjs";

const REMOTE_SCRIPT = String.raw`set -uo pipefail
emit() {
  local key="$1" value="$__OPEN__{2:-}"
  value=$__OPEN__{value//$'\t'/ }
  value=$__OPEN__{value//$'\r'/ }
  value=$__OPEN__{value//$'\n'/ }
  printf '%s\t%s\n' "$key" "$value"
}

emit hostname "$(hostname 2>/dev/null || true)"
emit os "$(grep -m1 PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
emit kernel "$(uname -r 2>/dev/null || true)"
emit uptime_seconds "$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null || true)"
emit cpu_cores "$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || true)"
emit load_1m "$(awk '{print $1}' /proc/loadavg 2>/dev/null || true)"
emit memory_total_mb "$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)"
emit memory_available_mb "$(awk '/^MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)"
emit swap_total_mb "$(awk '/^SwapTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)"
emit root_disk_used_percent "$(df -P / 2>/dev/null | awk 'NR==2 {gsub(/%/, "", $5); print $5}' || true)"

crawler_history_dir=/var/lib/ops-toolkit/crawler-history
if [[ -z "$__OPEN__{MONITOR_WINDOW_START:-}" && -d "$crawler_history_dir" ]] && compgen -G "$crawler_history_dir/*.tsv" >/dev/null; then
  cutoff=$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
  summary=$(awk -F '\t' -v cutoff="$cutoff" '
    $1 != "timestamp" && $1 >= cutoff {
      n++; total=$2
      if (min_available == "" || $3 < min_available) min_available=$3
      if ($4 > max_swap) max_swap=$4
      if ($5 > max_load) max_load=$5
      if ($6 > max_disk) max_disk=$6
      if ($7 > max_count) max_count=$7
      if ($8 > max_rss_sum) max_rss_sum=$8
      if ($9 > max_rss_one) max_rss_one=$9
    }
    END { printf "%d %.1f %.1f %.1f %.2f %d %d %.1f %.1f", n, total/1024, min_available/1024, max_swap/1024, max_load, max_disk, max_count, max_rss_sum/1024, max_rss_one/1024 }
  ' "$crawler_history_dir"/*.tsv 2>/dev/null || true)
  if [[ -n "$summary" ]]; then
    read -r crawler_samples crawler_mem_total_mb crawler_mem_available_min_mb crawler_swap_used_max_mb crawler_load_1m_max crawler_root_used_max_percent crawler_process_count_max crawler_rss_sum_max_mb crawler_rss_one_max_mb <<<"$summary"
    emit crawler_monitor_available true
    emit crawler_monitor_window_days 14
    emit crawler_monitor_samples "$crawler_samples"
    emit crawler_mem_total_mb "$crawler_mem_total_mb"
    emit crawler_mem_available_min_mb "$crawler_mem_available_min_mb"
    emit crawler_swap_used_max_mb "$crawler_swap_used_max_mb"
    emit crawler_load_1m_max "$crawler_load_1m_max"
    emit crawler_root_used_max_percent "$crawler_root_used_max_percent"
    emit crawler_process_count_max "$crawler_process_count_max"
    emit crawler_rss_sum_max_mb "$crawler_rss_sum_max_mb"
    emit crawler_rss_one_max_mb "$crawler_rss_one_max_mb"
  fi
fi

__MONITOR_SUMMARY__
for kind in php http; do
  if summary=$(monitor_summary "$kind" __HISTORY_DAYS__ 2>/dev/null); then
    while IFS='=' read -r key value; do
      if [[ "$kind" == php ]]; then
        case "$key" in available|window_days|samples) emit "php_fpm_monitor_$key" "$value" ;; *) emit "php_fpm_$key" "$value" ;; esac
      else
        emit "http_monitor_$key" "$value"
      fi
    done <<<"$summary"
  fi
done

token=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
if [[ -n "$token" ]]; then
  imds() { curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true; }
  emit cloud_provider aws
  emit instance_id "$(imds instance-id)"
  emit instance_type "$(imds instance-type)"
  az=$(imds placement/availability-zone)
  emit availability_zone "$az"
  emit region "$__OPEN__{az%?}"
fi

unit_files=$(systemctl list-unit-files 2>/dev/null || true)
web_service=""
for service in httpd apache2 nginx; do
  if grep -q "^$__OPEN__{service}\.service" <<<"$unit_files"; then web_service="$service"; break; fi
done
if [[ -n "$web_service" ]]; then
  emit web_service "$web_service"
  emit web_active "$(systemctl is-active "$web_service" 2>/dev/null || true)"
  emit web_enabled "$(systemctl is-enabled "$web_service" 2>/dev/null || true)"
  emit web_restart "$(systemctl show "$web_service" -p Restart --value 2>/dev/null || true)"
fi

php_service=$(grep -oE '^php[a-z0-9.-]*fpm\.service' <<<"$unit_files" | head -1 | sed 's/\.service$//' || true)
if [[ -n "$php_service" ]]; then
  emit php_service "$php_service"
  emit php_active "$(systemctl is-active "$php_service" 2>/dev/null || true)"
  emit php_memory_limit "$(php -r 'echo ini_get("memory_limit");' 2>/dev/null || true)"
  pool_conf=""
  for conf in /etc/php-fpm.d/*.conf /etc/php/*/fpm/pool.d/*.conf; do
    [[ -f "$conf" ]] || continue
    pool_conf="$conf"
    break
  done
  if [[ -n "$pool_conf" ]]; then
    emit php_pm "$(grep -E '^\s*pm\s*=' "$pool_conf" | tail -1 | awk -F= '{gsub(/^ +| +$/, "", $2); print $2}' || true)"
    emit php_max_children "$(grep -E '^\s*pm\.max_children\s*=' "$pool_conf" | tail -1 | grep -oE '[0-9]+' || true)"
    emit php_slowlog_enabled "$(grep -Eq '^\s*request_slowlog_timeout\s*=\s*[1-9]' "$pool_conf" && echo true || echo false)"
  fi
  rss_values=$(ps -C php-fpm -o rss=,args= 2>/dev/null | awk '!/master process/{print $1}' || true)
  if [[ -n "$rss_values" ]]; then
    emit php_worker_count "$(awk 'NF{n++} END{print n+0}' <<<"$rss_values")"
    emit php_worker_rss_avg_mb "$(awk 'NF{s+=$1;n++} END{if(n) printf "%.1f", s/n/1024}' <<<"$rss_values")"
    emit php_worker_rss_max_mb "$(awk 'NF&&$1>m{m=$1} END{if(m) printf "%.1f", m/1024}' <<<"$rss_values")"
  fi
fi

db_service=""
for service in mysqld mariadb; do
  if grep -q "^$__OPEN__{service}\.service" <<<"$unit_files"; then db_service="$service"; break; fi
done
if [[ -n "$db_service" ]]; then
  emit db_service "$db_service"
  emit db_active "$(systemctl is-active "$db_service" 2>/dev/null || true)"
fi

if command -v crontab >/dev/null 2>&1; then
  emit crontab_available true
  wp_cron_entries=$(crontab -l 2>/dev/null | grep -i 'wp-cron' || true)
  emit wp_cron_system "$([[ -n "$wp_cron_entries" ]] && echo true || echo false)"
else
  emit crontab_available false
  emit wp_cron_system false
fi

oom_log=""
if oom_log=$(set -o pipefail; sudo -n journalctl -k --since '-90 days' --no-pager 2>/dev/null | awk '/oom-killer invoked|Out of memory: Killed process/ { print }'); then
  emit oom_query_available true
else
  oom_log=""
  emit oom_query_available false
fi
emit oom_count_90d "$(grep -c 'Out of memory: Killed process' <<<"$oom_log" || true)"
emit oom_last_event "$(grep 'Out of memory: Killed process' <<<"$oom_log" | tail -1 || true)"
`.replace("__MONITOR_SUMMARY__", () => readFileSync(new URL("../scripts/monitor-summary.sh", import.meta.url), "utf8").replace("set -euo pipefail", "")).replaceAll("$__OPEN__{", "${");

function numberOrNull(value) {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRecords(stdout) {
  const values = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    values[line.slice(0, tab)] = line.slice(tab + 1);
  }
  return values;
}

export function collectHost(target, options = {}) {
  const window = options.window ? parseObservationWindow(options.window.start, options.window.end, { now: options.now }) : null;
  const historyDays = options.historyDays ?? 14;
  if (!Number.isInteger(historyDays) || historyDays < 1 || historyDays > 35) throw new Error("historyDays 必須是 1..35");
  const args = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${options.connectTimeout ?? 8}`];
  if (options.sshConfig) args.push("-F", options.sshConfig);
  if (options.port) args.push("-p", String(options.port));
  if (options.identityFile) args.push("-i", options.identityFile);
  args.push(target, "bash -s");

  const run = options.run ?? spawnSync;
  const result = run(options.sshCommand ?? "ssh", args, {
    input: (window ? `MONITOR_WINDOW_START='${window.start.replace(".000Z", "Z")}'\nMONITOR_WINDOW_END='${window.end.replace(".000Z", "Z")}'\n` : "") + REMOTE_SCRIPT.replace("__HISTORY_DAYS__", String(historyDays)),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
  });
  if (result.error) throw new Error(`SSH collector 執行失敗: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`SSH collector 回傳 ${result.status}: ${(result.stderr || "").trim()}`);

  const value = parseRecords(result.stdout);
  return {
    schema_version: "1.0",
    target,
    collected_at: new Date().toISOString(),
    observation: { type: "snapshot", oom_window_days: 90, ...(window ? { monitor_window: window, snapshot_scope: "current_configuration_not_historical", crawler_window_supported: false } : {}) },
    cloud: {
      provider: value.cloud_provider || null,
      instance_id: value.instance_id || null,
      instance_type: value.instance_type || null,
      region: value.region || null,
      availability_zone: value.availability_zone || null,
    },
    system: {
      hostname: value.hostname || null,
      os: value.os || null,
      kernel: value.kernel || null,
      uptime_seconds: numberOrNull(value.uptime_seconds),
      cpu_cores: numberOrNull(value.cpu_cores),
      load_1m: numberOrNull(value.load_1m),
      memory_total_mb: numberOrNull(value.memory_total_mb),
      memory_available_mb: numberOrNull(value.memory_available_mb),
      swap_total_mb: numberOrNull(value.swap_total_mb),
      root_disk_used_percent: numberOrNull(value.root_disk_used_percent),
    },
    crawler_monitor: {
      available: value.crawler_monitor_available === "true",
      window_days: numberOrNull(value.crawler_monitor_window_days),
      samples: numberOrNull(value.crawler_monitor_samples),
      memory_total_mb: numberOrNull(value.crawler_mem_total_mb),
      memory_available_min_mb: numberOrNull(value.crawler_mem_available_min_mb),
      swap_used_max_mb: numberOrNull(value.crawler_swap_used_max_mb),
      load_1m_max: numberOrNull(value.crawler_load_1m_max),
      root_disk_used_max_percent: numberOrNull(value.crawler_root_used_max_percent),
      process_count_max: numberOrNull(value.crawler_process_count_max),
      process_rss_sum_max_mb: numberOrNull(value.crawler_rss_sum_max_mb),
      process_rss_one_max_mb: numberOrNull(value.crawler_rss_one_max_mb),
    },
    web: {
      service: value.web_service || null,
      active: value.web_active || null,
      enabled: value.web_enabled || null,
      restart_policy: value.web_restart || null,
    },
    php_fpm: {
      service: value.php_service || null,
      active: value.php_active || null,
      pm: value.php_pm || null,
      max_children: numberOrNull(value.php_max_children),
      memory_limit: value.php_memory_limit || null,
      slowlog_enabled: value.php_slowlog_enabled === "true",
      worker_count: numberOrNull(value.php_worker_count),
      worker_rss_avg_mb: numberOrNull(value.php_worker_rss_avg_mb),
      worker_rss_max_mb: numberOrNull(value.php_worker_rss_max_mb),
    },
    php_fpm_monitor: {
      window_start: value.php_fpm_window_start || null,
      window_end: value.php_fpm_window_end || null,
      summary_version: numberOrNull(value.php_fpm_summary_version),
      covered_slots: numberOrNull(value.php_fpm_covered_slots),
      expected_slots: numberOrNull(value.php_fpm_expected_slots),
      coverage: numberOrNull(value.php_fpm_coverage),
      max_sample_gap_seconds: numberOrNull(value.php_fpm_max_sample_gap_seconds),
      duplicate_samples: numberOrNull(value.php_fpm_duplicate_samples),
      conflicting_samples: numberOrNull(value.php_fpm_conflicting_samples),
      invalid_samples: numberOrNull(value.php_fpm_invalid_samples),
      counter_resets: numberOrNull(value.php_fpm_counter_resets),
      pss_covered_slots: numberOrNull(value.php_fpm_pss_covered_slots),
      pss_expected_slots: numberOrNull(value.php_fpm_pss_expected_slots),
      pss_coverage: numberOrNull(value.php_fpm_pss_coverage),
      available: value.php_fpm_monitor_available === "true",
      window_days: numberOrNull(value.php_fpm_monitor_window_days),
      samples: numberOrNull(value.php_fpm_monitor_samples),
      listen_queue_max: numberOrNull(value.php_fpm_listen_queue_max),
      max_listen_queue_seen: numberOrNull(value.php_fpm_max_listen_queue_seen),
      active_processes_max: numberOrNull(value.php_fpm_active_processes_max),
      total_processes_max: numberOrNull(value.php_fpm_total_processes_max),
      max_active_processes_seen: numberOrNull(value.php_fpm_max_active_processes_seen),
      max_children_reached_counter_max: numberOrNull(value.php_fpm_max_children_reached_counter_max),
      max_children_reached_delta: numberOrNull(value.php_fpm_max_children_reached_delta),
      slow_requests_counter_max: numberOrNull(value.php_fpm_slow_requests_counter_max),
      slow_requests_delta: numberOrNull(value.php_fpm_slow_requests_delta),
      worker_rss_sum_max_mb: numberOrNull(value.php_fpm_worker_rss_sum_max_mb),
      worker_rss_one_max_mb: numberOrNull(value.php_fpm_worker_rss_one_max_mb),
      worker_pss_available_samples: numberOrNull(value.php_fpm_worker_pss_available_samples),
      worker_pss_sum_max_mb: numberOrNull(value.php_fpm_worker_pss_sum_max_mb),
      worker_pss_one_max_mb: numberOrNull(value.php_fpm_worker_pss_one_max_mb),
      memory_available_min_mb: numberOrNull(value.php_fpm_memory_available_min_mb),
      swap_used_max_mb: numberOrNull(value.php_fpm_swap_used_max_mb),
    },
    http_monitor: {
      boundary_samples_excluded: numberOrNull(value.http_monitor_boundary_samples_excluded),
      window_start: value.http_monitor_window_start || null,
      window_end: value.http_monitor_window_end || null,
      summary_version: numberOrNull(value.http_monitor_summary_version),
      producer_version: value.http_monitor_producer_version || null,
      valid_since: value.http_monitor_valid_since || null,
      compatibility: value.http_monitor_compatibility || null,
      covered_slots: numberOrNull(value.http_monitor_covered_slots),
      expected_slots: numberOrNull(value.http_monitor_expected_slots),
      coverage: numberOrNull(value.http_monitor_coverage),
      max_sample_gap_seconds: numberOrNull(value.http_monitor_max_sample_gap_seconds),
      duplicate_samples: numberOrNull(value.http_monitor_duplicate_samples),
      conflicting_samples: numberOrNull(value.http_monitor_conflicting_samples),
      invalid_samples: numberOrNull(value.http_monitor_invalid_samples),
      collection_gap_count: numberOrNull(value.http_monitor_collection_gap_count),
      latency_eligible_samples: numberOrNull(value.http_monitor_latency_eligible_samples),
      latency_slow_samples: numberOrNull(value.http_monitor_latency_slow_samples),
      latency_slow_consecutive_slots: numberOrNull(value.http_monitor_latency_slow_consecutive_slots),
      latency_threshold_ms: numberOrNull(value.http_monitor_latency_threshold_ms),
      latency_min_requests: numberOrNull(value.http_monitor_latency_min_requests),
      available: value.http_monitor_available === "true",
      window_days: numberOrNull(value.http_monitor_window_days),
      samples: numberOrNull(value.http_monitor_samples),
      active_minutes: numberOrNull(value.http_monitor_active_minutes),
      requests: numberOrNull(value.http_monitor_requests),
      status_2xx: numberOrNull(value.http_monitor_status_2xx),
      status_3xx: numberOrNull(value.http_monitor_status_3xx),
      status_4xx: numberOrNull(value.http_monitor_status_4xx),
      status_5xx: numberOrNull(value.http_monitor_status_5xx),
      status_5xx_rate_percent: numberOrNull(value.http_monitor_status_5xx_rate_percent),
      latency_p95_peak_ms: numberOrNull(value.http_monitor_latency_p95_peak_ms),
      latency_p99_peak_ms: numberOrNull(value.http_monitor_latency_p99_peak_ms),
      latency_max_ms: numberOrNull(value.http_monitor_latency_max_ms),
    },
    database: {
      service: value.db_service || null,
      active: value.db_active || null,
    },
    wp_cron: {
      crontab_available: value.crontab_available === "true",
      system_trigger_detected: value.wp_cron_system === "true",
    },
    oom: {
      query_available: value.oom_query_available === "true",
      count_90d: value.oom_query_available === "true" ? numberOrNull(value.oom_count_90d) : null,
      last_event: value.oom_last_event || null,
    },
  };
}
