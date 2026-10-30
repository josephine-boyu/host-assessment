import { hasCompletedEvent } from "./events.mjs";
import { compareTargetCapacity } from "./target-capacity.mjs";
import { splitUtcWindow } from "./observation-window.mjs";

function finite(value) {
  return Number.isFinite(value);
}

function round(value, digits = 2) {
  return finite(value) ? Number(value.toFixed(digits)) : null;
}

function minimumCoverage(coverage, keys) {
  const values = keys.map((key) => coverage?.[key]).filter((value) => finite(value) && value >= 0 && value <= 1);
  return values.length === keys.length ? Math.min(...values) : 0;
}

function monitorCoverage(monitor, start, end, label, missing) {
  const expected = (Date.parse(end) - Date.parse(start)) / 60000;
  if (monitor.summary_version !== 2) missing.push(`${label}_summary_v2_required`);
  if (Date.parse(monitor.window_start) !== Date.parse(start) || Date.parse(monitor.window_end) !== Date.parse(end)) missing.push(`${label}_window_mismatch`);
  if (!finite(expected) || expected <= 0 || monitor.expected_slots !== expected
    || !Number.isInteger(monitor.covered_slots) || monitor.covered_slots < 0 || monitor.covered_slots > expected) {
    missing.push(`${label}_slot_evidence_invalid`); return 0;
  }
  if (monitor.invalid_samples !== 0 || monitor.conflicting_samples !== 0) missing.push(`${label}_invalid_or_conflicting_samples`);
  if (label === "http" && monitor.collection_gap_count !== 0) missing.push("http_collection_gaps_or_unknown");
  if (label === "http" && (monitor.producer_version !== "http-filtered-v1"
    || !finite(Date.parse(monitor.valid_since)) || Date.parse(monitor.valid_since) > Date.parse(start))) {
    missing.push("http_producer_or_valid_start_unverified");
  }
  if (!finite(monitor.max_sample_gap_seconds) || monitor.max_sample_gap_seconds > 600) missing.push(`${label}_gap_over_10_minutes_or_unknown`);
  return monitor.covered_slots / expected;
}

export function decideRightsizing14d({ hostAudit, awsHistory, events = [], targetMemoryMib = 4096, requiredEvent = "pdf-email-test", targetProfile }) {
  const targetType = targetProfile?.instance_type ?? "t3.medium";
  if (targetProfile) targetMemoryMib = targetProfile.memory_mib;
  if (hostAudit?.schema_version !== "1.0") throw new Error("不支援的 host audit schema");
  if (awsHistory?.schema_version !== "1.0" || awsHistory?.type !== "aws_cloudwatch_history") throw new Error("不支援的 AWS history schema");
  if (hostAudit.cloud?.instance_id !== awsHistory.instance?.instance_id) throw new Error("host 與 AWS instance_id 不一致");
  if (!Number.isInteger(targetMemoryMib) || targetMemoryMib < 1024) throw new Error("targetMemoryMib 必須是至少 1024 的整數");

  const missing = [];
  const reasons = [];
  const days = awsHistory.window?.days ?? 0;
  const windowStart = awsHistory.window?.start;
  const windowEnd = awsHistory.window?.end;
  const expectedSegments = finite(Date.parse(windowStart)) && finite(Date.parse(windowEnd)) && Date.parse(windowEnd)>Date.parse(windowStart) ? splitUtcWindow(awsHistory.window) : [];
  if (!finite(Date.parse(windowStart)) || !finite(Date.parse(windowEnd)) || (Date.parse(windowEnd)-Date.parse(windowStart))/86400000 !== days) missing.push("invalid_observation_window");
  if (days < 14) missing.push("observation_window_below_14_days");
  if (!targetProfile && awsHistory.instance?.instance_type !== "t3.large") missing.push(`unsupported_source_instance_type:${awsHistory.instance?.instance_type ?? "unknown"}`);
  const capacity = compareTargetCapacity(awsHistory, targetProfile ?? awsHistory.comparison_instance_types?.[targetType]);
  missing.push(...capacity.missing); reasons.push(...capacity.reasons);

  const cloudCoverage = minimumCoverage(awsHistory.coverage, ["cpu_avg", "cpu_p95", "cpu_max", "mem_used_avg", "mem_used_p95", "mem_used_max"]);
  if (cloudCoverage < 0.9) missing.push("cloudwatch_cpu_memory_coverage_below_90_percent");

  const php = hostAudit.php_fpm_monitor ?? {};
  const phpCoverage = monitorCoverage(php, windowStart, windowEnd, "php_fpm", missing);
  if (!php.available || phpCoverage < 0.9) missing.push("php_fpm_monitor_coverage_below_90_percent");
  if ((php.worker_pss_available_samples ?? 0) === 0) missing.push("php_fpm_pss_missing");
  const expectedPss = Math.ceil((Date.parse(windowEnd)-Date.parse(windowStart))/300000);
  if (php.pss_expected_slots !== expectedPss || !Number.isInteger(php.pss_covered_slots) || php.pss_covered_slots > expectedPss || php.pss_covered_slots < expectedPss * 0.9) missing.push("php_fpm_pss_coverage_below_90_percent");
  for (const key of ["listen_queue_max", "max_children_reached_delta", "worker_pss_one_max_mb", "active_processes_max"]) {
    if (!finite(php[key]) || php[key] < 0) missing.push(`php_fpm_${key}_unknown`);
  }

  const http = hostAudit.http_monitor ?? {};
  const httpCoverage = monitorCoverage(http, windowStart, windowEnd, "http", missing);
  if (!http.available || httpCoverage < 0.9) missing.push("http_monitor_coverage_below_90_percent");
  for (const key of ["requests", "status_5xx_rate_percent", "latency_p95_peak_ms", "latency_slow_samples", "latency_slow_consecutive_slots"]) {
    if (!finite(http[key]) || http[key] < 0) missing.push(`http_${key}_unknown`);
  }
  if (!(http.requests > 0)) missing.push("http_representative_traffic_missing");
  if (hostAudit.oom?.query_available !== true || !finite(hostAudit.oom?.count_90d) || hostAudit.oom.count_90d < 0) missing.push("oom_history_unknown");

  const eventCovered = Boolean(windowStart && windowEnd && hasCompletedEvent(events, requiredEvent, windowStart, windowEnd, hostAudit.target));
  if (!eventCovered) missing.push(`required_event_missing:${requiredEvent}`);

  const ebsVolumes = awsHistory.ebs?.volumes ?? [];
  const ebsDays = awsHistory.ebs?.daily ?? [];
  const ebsDates = ebsDays.map(day => day.date);
  if (ebsDates.length !== expectedSegments.length || new Set(ebsDates).size !== expectedSegments.length
    || ebsDates.some(date => !expectedSegments.some(segment => segment.date === date))) missing.push("ebs_dates_missing_duplicate_or_outside_window");
  if (awsHistory.window?.explicit && ebsDays.some(day => !expectedSegments.some(segment => segment.date === day.date
    && segment.start.toISOString() === day.window_start && segment.end.toISOString() === day.window_end))) missing.push("ebs_segment_boundaries_missing_or_mismatched");
  for (const volume of ebsVolumes) {
    if (ebsDays.some(day => !day.volumes?.[volume.volume_id])) missing.push(`ebs_daily_volume_missing:${volume.volume_id}`);
  }
  const ebsCoverage = awsHistory.ebs?.coverage ?? {};
  if (!ebsVolumes.length) {
    missing.push("ebs_inventory_missing");
  } else {
    for (const { volume_id: volumeId } of ebsVolumes) {
      const coverage = ebsCoverage[volumeId] ?? {};
      // Exceeded checks describe the current volume, not the smaller target's
      // capacity. Peak inputs always need independently complete source slots.
      for (const key of ["read_ops_minute", "write_ops_minute", "read_bytes_minute", "write_bytes_minute", "read_time_minute", "write_time_minute", "queue_minute"]) {
        if (minimumCoverage(coverage, [key]) < 0.9) missing.push(`ebs_peak_${key}_coverage_below_90_percent:${volumeId}`);
      }
      if ((coverage.queue_max ?? 0) < 0.9) missing.push(`ebs_queue_coverage_below_90_percent:${volumeId}`);
      const availability = awsHistory.ebs?.metric_availability?.[volumeId];
      const exceededAvailable = availability
        ? availability.iops_exceeded === "available" || availability.throughput_exceeded === "available"
        : Math.max(coverage.iops_exceeded ?? 0, coverage.throughput_exceeded ?? 0) > 0;
      if (exceededAvailable) {
        const exceededCoverage = Math.max(coverage.iops_exceeded ?? 0, coverage.throughput_exceeded ?? 0);
        if (exceededCoverage < 0.9) missing.push(`ebs_exceeded_check_coverage_below_90_percent:${volumeId}`);
      }
    }
  }

  const dailyMetrics = awsHistory.daily?.flatMap(({ metrics }) => metrics ? [metrics] : []) ?? [];
  const dates=(awsHistory.daily??[]).map(day=>day.date);
  if (new Set(dates).size !== expectedSegments.length || dates.some(date=>!expectedSegments.some(s=>s.date===date))) missing.push("daily_dates_missing_duplicate_or_outside_window");
  if (awsHistory.window?.explicit && (awsHistory.daily??[]).some(day=>!expectedSegments.some(s=>s.date===day.date && s.start.toISOString()===day.window_start && s.end.toISOString()===day.window_end))) missing.push("daily_segment_boundaries_missing_or_mismatched");
  for (const key of ["cpu_avg", "cpu_p95", "cpu_max", "mem_used_avg", "mem_used_p95", "mem_used_max"]) {
    if (dailyMetrics.length !== expectedSegments.length || dailyMetrics.some((row) => !finite(row[key]) || row[key] < 0 || row[key] > 100)) missing.push(`daily_${key}_missing_or_invalid`);
  }
  const peakMemoryPercent = Math.max(0, ...dailyMetrics.map(({ mem_used_max }) => finite(mem_used_max) ? mem_used_max : 0));
  const statusCheckFailed = dailyMetrics.some(row => finite(row.status_failed) && row.status_failed > 0);
  if (minimumCoverage(awsHistory.coverage, ["status_failed"]) < 0.9
    || dailyMetrics.some(row => !finite(row.status_failed) || row.status_failed < 0 || row.status_failed > 1)) missing.push("ec2_status_check_evidence_missing_or_invalid");
  const cpuP95Peak = Math.max(0, ...dailyMetrics.map(({ cpu_p95 }) => finite(cpu_p95) ? cpu_p95 : 0));
  const currentMemoryMib = awsHistory.instance?.memory_mib ?? hostAudit.system?.memory_total_mb;
  if (!finite(currentMemoryMib) || currentMemoryMib <= 0) missing.push("source_memory_unknown");
  const projectedUsedMib = finite(currentMemoryMib) ? currentMemoryMib * peakMemoryPercent / 100 : null;
  const projectedTargetPercent = finite(projectedUsedMib) ? projectedUsedMib / targetMemoryMib * 100 : null;

  const ebsDailyVolumes = awsHistory.ebs?.daily?.flatMap(({ volumes = {} }) => Object.values(volumes)) ?? [];
  const ebsExceeded = ebsDailyVolumes.some((volume) => (volume.iops_exceeded ?? 0) > 0 || (volume.throughput_exceeded ?? 0) > 0 || (volume.stalled ?? 0) > 0);
  const ebsFallbackPressure = (awsHistory.ebs?.volumes ?? []).some((volume) => {
    const samples = (awsHistory.ebs?.daily ?? []).flatMap(({ volumes = {} }) => volumes[volume.volume_id] ? [volumes[volume.volume_id]] : []);
    const peak = (key) => Math.max(0, ...samples.map((sample) => finite(sample[key]) ? sample[key] : 0));
    const iopsPeak = peak("read_iops_peak") + peak("write_iops_peak");
    const throughputPeak = peak("read_throughput_mib_s_peak") + peak("write_throughput_mib_s_peak");
    return (finite(volume.provisioned_iops) && iopsPeak >= volume.provisioned_iops)
      || (finite(volume.provisioned_throughput_mib_s) && throughputPeak >= volume.provisioned_throughput_mib_s)
      || peak("queue_minute_peak") >= 5
      || peak("read_latency_minute_peak_ms") >= 20
      || peak("write_latency_minute_peak_ms") >= 20;
  });
  const recentOom = (hostAudit.oom?.count_90d ?? 0) > 0;
  const phpSaturated = (php.listen_queue_max ?? 0) > 0 || (php.max_children_reached_delta ?? 0) > 0;
  const httpUnhealthy = ((http.requests ?? 0) >= 100 && (http.status_5xx_rate_percent ?? 0) >= 1)
    || (http.latency_slow_consecutive_slots ?? 0) >= 5;
  const cpuPressure = cpuP95Peak >= 60;
  const memoryUnsafeForTarget = projectedTargetPercent === null || projectedTargetPercent >= 80;
  const workerCapacity = php.worker_pss_one_max_mb > 0 ? Math.floor((targetMemoryMib - Math.max(512, targetMemoryMib*0.35)) / (php.worker_pss_one_max_mb*1.25)) : null;
  const workerPressure = workerCapacity === null || php.active_processes_max > workerCapacity;
  if (workerPressure) reasons.push("target_php_worker_budget_insufficient_or_unknown");
  if (recentOom) reasons.push("recent_oom");
  if (statusCheckFailed) reasons.push("aws_status_check_failed");
  if (phpSaturated) reasons.push("php_fpm_saturation");
  if (memoryUnsafeForTarget) reasons.push("target_memory_headroom_below_20_percent");
  if (httpUnhealthy) reasons.push("http_latency_or_5xx_unhealthy");
  if (ebsExceeded) reasons.push("ebs_performance_pressure");
  if (ebsFallbackPressure) reasons.push("ebs_fallback_peak_pressure");
  if (cpuPressure) reasons.push("cpu_p95_pressure");

  if (missing.length) {
    return {
      schema_version: "1.0",
      decision: "insufficient_data",
      target_instance_type: targetType,
      target_memory_mib: targetMemoryMib,
      missing: [...new Set(missing)],
      reasons,
      evidence: { ...capacity.evidence, days, cloud_coverage_minimum: round(cloudCoverage, 4), php_coverage: round(phpCoverage, 4), http_coverage: round(httpCoverage, 4), required_event_covered: eventCovered, projected_target_memory_percent: round(projectedTargetPercent), cpu_p95_peak_percent: round(cpuP95Peak), target_worker_capacity_estimate: workerCapacity },
      apply_automatically: false,
    };
  }

  let decision = targetProfile ? "target_trial_candidate" : "t3_medium_trial_candidate";
  if (statusCheckFailed) {
    decision = targetProfile ? "maintain_current" : "maintain_t3_large";
  } else if (recentOom || phpSaturated || memoryUnsafeForTarget || workerPressure) {
    decision = "tune_php_fpm";
  } else if (httpUnhealthy || ebsExceeded || ebsFallbackPressure || cpuPressure || capacity.reasons.length) {
    decision = targetProfile ? "maintain_current" : "maintain_t3_large";
  } else {
    reasons.push("coverage_and_peak_requirements_met");
  }

  return {
    schema_version: "1.0",
    decision,
    target_instance_type: targetType,
    target_memory_mib: targetMemoryMib,
    missing: [],
    reasons,
    evidence: {
      ...capacity.evidence,
      target_worker_capacity_estimate: workerCapacity,
      days,
      cloud_coverage_minimum: round(cloudCoverage, 4),
      php_coverage: round(phpCoverage, 4),
      http_coverage: round(httpCoverage, 4),
      required_event_covered: eventCovered,
      current_memory_mib: currentMemoryMib ?? null,
      memory_peak_percent: round(peakMemoryPercent),
      projected_used_mib: round(projectedUsedMib),
      projected_target_memory_percent: round(projectedTargetPercent),
      cpu_p95_peak_percent: round(cpuP95Peak),
      php_listen_queue_max: php.listen_queue_max ?? null,
      php_max_children_reached_delta: php.max_children_reached_delta ?? null,
      http_5xx_rate_percent: http.status_5xx_rate_percent ?? null,
      http_latency_p95_peak_ms: http.latency_p95_peak_ms ?? null,
      http_latency_semantics: "maximum_of_sample_p95_not_period_p95",
      http_slow_samples: http.latency_slow_samples ?? null,
      http_slow_consecutive_slots: http.latency_slow_consecutive_slots ?? null,
      ebs_performance_exceeded: ebsExceeded,
      ebs_fallback_peak_pressure: ebsFallbackPressure,
      recent_oom: recentOom,
      ec2_status_check_failed: statusCheckFailed,
    },
    apply_automatically: false,
  };
}

export function renderRightsizingDecision(decision, target) {
  const lines = [
    `# 14 天規格決策：${target}`,
    "",
    `- 結論：\`${decision.decision}\``,
    `- 目標：${decision.target_instance_type} / ${decision.target_memory_mib} MiB`,
    `- 自動套用：否`,
    `- 範圍：實驗性 14 天試降候選；不是 30 天正式容量核准，也不保證降規成功。`,
    `- 延遲：latency_p95_peak_ms 是各採樣區間 p95 的最大值，不是全期 p95。`,
    "",
    "## 原因",
    "",
    ...(decision.reasons.length ? decision.reasons.map((reason) => `- ${reason}`) : ["- 尚無可用結論"]),
    "",
    "## 缺少資料",
    "",
    ...(decision.missing.length ? decision.missing.map((item) => `- ${item}`) : ["- 無"]),
    "",
    "## 證據",
    "",
    "```json",
    JSON.stringify(decision.evidence, null, 2),
    "```",
    "",
    "此報告只提出人工審核候選，不會修改 EC2、PHP-FPM 或其他基礎設施。",
    "",
  ];
  return lines.join("\n");
}
