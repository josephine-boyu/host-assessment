const rank = { critical: 3, warning: 2, recommendation: 1, info: 0 };

function values(history, metric) {
  return history.daily.flatMap(({ metrics }) => {
    const value = metrics?.[metric];
    return Number.isFinite(value) ? [value] : [];
  });
}

function minimum(list) {
  return list.length ? Math.min(...list) : null;
}

function maximum(list) {
  return list.length ? Math.max(...list) : null;
}

function sum(list) {
  return list.length ? list.reduce((total, value) => total + value, 0) : null;
}

function average(list) {
  return list.length ? sum(list) / list.length : null;
}

function windowAverage(history, metric, countKey) {
  if (!history.window?.explicit) return average(values(history,metric));
  const rows=history.daily??[];
  if (!rows.length || rows.some(({metrics:m})=>!Number.isFinite(m?.[metric]) || !Number.isFinite(m?.[countKey]) || m[countKey]<=0)) return null;
  const count=rows.reduce((n,{metrics:m})=>n+m[countKey],0);
  return rows.reduce((n,{metrics:m})=>n+m[metric]*m[countKey],0)/count;
}

function ebsValues(history, metric) {
  return (history.ebs?.daily ?? []).flatMap(({ volumes = {} }) => Object.values(volumes).flatMap((volume) => Number.isFinite(volume?.[metric]) ? [volume[metric]] : []));
}

function round(value, digits = 2) {
  return value === null ? null : Number(value.toFixed(digits));
}

function finding(severity, code, summary, evidence, recommendation, confidence = "high") {
  return { severity, code, summary, evidence, recommendation, confidence };
}

export function summarizeAwsHistory(history) {
  const cpuAvg = values(history, "cpu_avg");
  const cpuP95 = values(history, "cpu_p95");
  const cpuMax = values(history, "cpu_max");
  const creditMin = values(history, "cpu_credit_min");
  const surplusMax = values(history, "cpu_surplus_max");
  const surplusCharged = values(history, "cpu_surplus_charged");
  const statusFailed = values(history, "status_failed");
  return {
    cpu_avg_mean_percent: round(windowAverage(history,"cpu_avg","cpu_sample_count")),
    cpu_daily_p95_peak_percent: round(maximum(cpuP95)),
    cpu_instant_max_peak_percent: round(maximum(cpuMax)),
    cpu_credit_minimum: round(minimum(creditMin)),
    cpu_surplus_balance_maximum: round(maximum(surplusMax)),
    cpu_surplus_charged_total: round(sum(surplusCharged)),
    status_check_failed_maximum: round(maximum(statusFailed)),
    network_in_total_bytes: round(sum(values(history, "network_in")), 0),
    network_out_total_bytes: round(sum(values(history, "network_out")), 0),
    network_in_peak_mib_s: round(maximum(values(history, "network_in_peak_mib_s")), 4),
    network_out_peak_mib_s: round(maximum(values(history, "network_out_peak_mib_s")), 4),
    ebs_read_total_bytes: round(sum(values(history, "ebs_read_bytes")), 0),
    ebs_write_total_bytes: round(sum(values(history, "ebs_write_bytes")), 0),
    memory_used_mean_percent: round(windowAverage(history,"mem_used_avg","memory_sample_count")),
    memory_daily_p95_peak_percent: round(maximum(values(history, "mem_used_p95"))),
    memory_instant_max_peak_percent: round(maximum(values(history, "mem_used_max"))),
    swap_used_maximum_percent: round(maximum(values(history, "swap_used_max"))),
    root_disk_used_maximum_percent: round(maximum(values(history, "disk_used_max"))),
    ebs_queue_maximum: round(maximum(ebsValues(history, "queue_max"))),
    ebs_read_latency_maximum_ms: round(maximum(ebsValues(history, "read_latency_ms"))),
    ebs_write_latency_maximum_ms: round(maximum(ebsValues(history, "write_latency_ms"))),
    ebs_iops_exceeded_maximum: round(maximum(ebsValues(history, "iops_exceeded"))),
    ebs_throughput_exceeded_maximum: round(maximum(ebsValues(history, "throughput_exceeded"))),
    ebs_stalled_maximum: round(maximum(ebsValues(history, "stalled"))),
    ebs_burst_balance_minimum_percent: round(minimum(ebsValues(history, "burst_balance_min_percent"))),
    ebs_read_iops_peak: round(maximum(ebsValues(history, "read_iops_peak"))),
    ebs_write_iops_peak: round(maximum(ebsValues(history, "write_iops_peak"))),
    ebs_read_throughput_mib_s_peak: round(maximum(ebsValues(history, "read_throughput_mib_s_peak"))),
    ebs_write_throughput_mib_s_peak: round(maximum(ebsValues(history, "write_throughput_mib_s_peak"))),
    ebs_queue_minute_peak: round(maximum(ebsValues(history, "queue_minute_peak"))),
    ebs_read_latency_minute_peak_ms: round(maximum(ebsValues(history, "read_latency_minute_peak_ms"))),
    ebs_write_latency_minute_peak_ms: round(maximum(ebsValues(history, "write_latency_minute_peak_ms"))),
  };
}

export function analyzeAwsHistory(history, hostAudit) {
  if (history?.schema_version !== "1.0" || history?.type !== "aws_cloudwatch_history") throw new Error("不支援的 AWS history schema");
  if (hostAudit?.schema_version !== "1.0") throw new Error("不支援的 host audit schema");
  if (history.instance?.instance_id !== hostAudit.cloud?.instance_id) throw new Error("AWS history 與 host audit 的 instance_id 不一致");

  const summary = summarizeAwsHistory(history);
  const findings = [];
  const coverageValues = Object.values(history.coverage ?? {}).filter(Number.isFinite);
  const coverageMinimum = coverageValues.length ? Math.min(...coverageValues) : 0;
  const recentOom = (hostAudit.oom?.count_90d ?? 0) > 0;
  const guestMemoryCoverage = history.coverage?.mem_used_max ?? 0;
  const guestMemoryDiscovered = history.guest_metrics?.discovered?.includes("mem_used_percent") || guestMemoryCoverage > 0;
  const unavailableExceededChecks = Object.entries(history.ebs?.metric_availability ?? {})
    .filter(([, availability]) => availability.iops_exceeded === "not_available" || availability.throughput_exceeded === "not_available")
    .map(([volumeId]) => volumeId);

  if (recentOom) {
    findings.push(finding("critical", "recent_oom_blocks_downsize", `SSH 快照顯示近 90 天發生 ${hostAudit.oom.count_90d} 次 OOM`, { count: hostAudit.oom.count_90d, last_event: hostAudit.oom.last_event }, "先釐清 PHP-FPM 記憶體尖峰；在取得 guest RAM 歷史且 OOM 問題解除前，不提出降規。"));
  }
  if ((summary.status_check_failed_maximum ?? 0) > 0) {
    findings.push(finding("critical", "aws_status_check_failed", "觀測期內出現 EC2 status check failure", { maximum: summary.status_check_failed_maximum }, "比對發生日期與 AWS event、system log，先處理可用性問題。"));
  }
  if ((summary.cpu_daily_p95_peak_percent ?? 100) >= 80) {
    findings.push(finding("warning", "sustained_cpu_pressure", "至少一天的 CPU p95 達 80% 以上", { peak_daily_p95_percent: summary.cpu_daily_p95_peak_percent }, "比對 latency、request rate 與持續天數，再判斷程式調校或升規。", "medium"));
  } else if (summary.cpu_daily_p95_peak_percent !== null && (summary.status_check_failed_maximum ?? 0) === 0) {
    findings.push(finding("info", "cpu_capacity_available", "CloudWatch CPU 指標顯示尚有容量餘裕", { average_percent: summary.cpu_avg_mean_percent, peak_daily_p95_percent: summary.cpu_daily_p95_peak_percent, instant_max_peak_percent: summary.cpu_instant_max_peak_percent }, "此結論只涵蓋 CPU，不能單獨支持整機降規。", "high"));
  }
  if ((summary.cpu_surplus_charged_total ?? 0) > 0 || summary.cpu_credit_minimum === 0) {
    findings.push(finding("warning", "t_instance_credit_pressure", "T 系列曾耗盡 credit 或產生 surplus charge", { credit_minimum: summary.cpu_credit_minimum, surplus_charged_total: summary.cpu_surplus_charged_total }, "確認高 CPU 工作是否持續，並比較一般用途非 burstable family。", "high"));
  } else if (summary.cpu_credit_minimum !== null) {
    findings.push(finding("info", "t_instance_credit_healthy", "觀測期內未見 T 系列 credit 壓力", { credit_minimum: summary.cpu_credit_minimum, surplus_charged_total: summary.cpu_surplus_charged_total }, "持續在每日 summary 追蹤最低 credit 與 charge。", "high"));
  }
  if (coverageMinimum < 0.9) {
    findings.push(finding("warning", "cloudwatch_coverage_incomplete", "CloudWatch 指標 coverage 低於 90%", { minimum_coverage: round(coverageMinimum * 100, 1) }, "先處理資料缺口，避免把缺值誤判成低用量。"));
  }

  if (!guestMemoryDiscovered) {
    findings.push(finding("warning", "guest_memory_history_missing", "尚未取得 guest RAM 歷史", { snapshot_memory_total_mb: hostAudit.system?.memory_total_mb ?? null, snapshot_memory_available_mb: hostAudit.system?.memory_available_mb ?? null, snapshot_swap_total_mb: hostAudit.system?.swap_total_mb ?? null }, "安裝最小化 CloudWatch Agent，並確認 CWAgent 指標使用正確的 InstanceId dimension。", "high"));
  } else if (guestMemoryCoverage < 0.9) {
    findings.push(finding("warning", "guest_memory_coverage_incomplete", "CWAgent RAM 歷史 coverage 尚未達 90%", { coverage_percent: round(guestMemoryCoverage * 100, 1), peak_percent: summary.memory_instant_max_peak_percent }, "持續收集完整觀測期；coverage 足夠前不提出降規。", "high"));
  }
  if ((summary.memory_instant_max_peak_percent ?? 0) >= 90) {
    findings.push(finding("warning", "guest_memory_pressure", "觀測期內 guest RAM 使用率曾達 90% 以上", { peak_percent: summary.memory_instant_max_peak_percent, daily_p95_peak_percent: summary.memory_daily_p95_peak_percent }, "比對 OOM、PHP-FPM worker 與發生時段，先處理記憶體壓力再評估規格。", "high"));
  }
  if ((summary.ebs_stalled_maximum ?? 0) > 0) {
    findings.push(finding("critical", "ebs_stalled_io", "觀測期內 EBS 曾回報 stalled I/O", { maximum: summary.ebs_stalled_maximum }, "先處理磁碟健康或 AWS 基礎設施事件，不提出降規。", "high"));
  }
  if ((summary.ebs_iops_exceeded_maximum ?? 0) > 0 || (summary.ebs_throughput_exceeded_maximum ?? 0) > 0) {
    findings.push(finding("warning", "ebs_performance_exceeded", "觀測期內 EBS 曾超過 provisioned IOPS 或 throughput", { iops_exceeded: summary.ebs_iops_exceeded_maximum, throughput_exceeded: summary.ebs_throughput_exceeded_maximum, queue_max: summary.ebs_queue_maximum }, "比對 latency、queue 與工作時段；先處理 EBS 瓶頸再評估 instance 規格。", "high"));
  }
  if (unavailableExceededChecks.length) {
    findings.push(finding("info", "ebs_exceeded_check_not_available", "部分 EBS exceeded-check 指標未由 CloudWatch 提供，已改用實際峰值與額定值判斷", { volumes: unavailableExceededChecks, read_iops_peak: summary.ebs_read_iops_peak, write_iops_peak: summary.ebs_write_iops_peak, read_throughput_mib_s_peak: summary.ebs_read_throughput_mib_s_peak, write_throughput_mib_s_peak: summary.ebs_write_throughput_mib_s_peak, queue_peak: summary.ebs_queue_minute_peak }, "持續觀察細粒度 IOPS、throughput、queue 與 latency；not_available 不視為零，也不單獨構成資料不足。", "high"));
  }
  if ((summary.ebs_burst_balance_minimum_percent ?? 100) < 20) {
    findings.push(finding("warning", "ebs_burst_balance_low", "EBS burst balance 曾低於 20%", { minimum_percent: summary.ebs_burst_balance_minimum_percent }, "確認 gp2/st1/sc1 是否受到 credit 限制，避免把磁碟節流誤判成 instance 容量問題。", "high"));
  }

  if (history.evaluation_stage === "preliminary_14d") {
    findings.push(finding("info", "preliminary_window", "目前是 14 天初評階段", { days: history.window.days }, "持續累積至 30 天並涵蓋業務尖峰，才進行正式 rightsizing。", "high"));
  }

  findings.sort((a, b) => rank[b.severity] - rank[a.severity]);
  return {
    schema_version: "1.0",
    type: "aws_history_analysis",
    target: hostAudit.target,
    analyzed_at: new Date().toISOString(),
    evaluation_stage: history.evaluation_stage,
    operational_action: recentOom ? "tune" : "maintain",
    rightsizing_status: "insufficient_data",
    downsize_eligible: false,
    summary,
    coverage_minimum: round(coverageMinimum, 4),
    findings,
  };
}
