const rank = { critical: 3, warning: 2, recommendation: 1, info: 0 };

function finding(severity, code, summary, evidence, recommendation, confidence = "high") {
  return { severity, code, summary, evidence, recommendation, confidence };
}

function phpFpmCandidate(system, php, monitor, expectedConcurrency) {
  const memoryTotalMb = system.memory_total_mb;
  const observedWorkerMemoryMb = monitor.worker_pss_one_max_mb || monitor.worker_rss_one_max_mb || php.worker_rss_max_mb;
  const observedWorkerMemorySource = monitor.worker_pss_one_max_mb ? "history_pss" : monitor.worker_rss_one_max_mb ? "history_rss" : php.worker_rss_max_mb ? "snapshot_rss" : null;
  const base = {
    apply_automatically: false,
    expected_concurrency: expectedConcurrency ?? null,
    memory_total_mb: memoryTotalMb ?? null,
    observed_worker_rss_max_mb: php.worker_rss_max_mb ?? null,
    observed_worker_memory_mb: observedWorkerMemoryMb ?? null,
    observed_worker_memory_source: observedWorkerMemorySource,
    safety_factor: 1.25,
  };

  if (!Number.isInteger(expectedConcurrency) || expectedConcurrency < 1) {
    return { ...base, status: "insufficient_data", reason: "expected_concurrency_missing" };
  }
  if (!(memoryTotalMb > 0) || !(observedWorkerMemoryMb > 0)) {
    return { ...base, status: "insufficient_data", reason: "memory_or_worker_rss_missing" };
  }

  const reservedNonPhpMb = Math.ceil(Math.max(512, memoryTotalMb * 0.35));
  const workerBudgetMb = Math.ceil(observedWorkerMemoryMb * base.safety_factor);
  const availableForPhpMb = Math.max(0, memoryTotalMb - reservedNonPhpMb);
  const memoryCapacityChildren = Math.floor(availableForPhpMb / workerBudgetMb);
  const maxChildren = memoryCapacityChildren > 0 ? Math.min(expectedConcurrency, memoryCapacityChildren) : null;
  const status = memoryCapacityChildren >= expectedConcurrency ? "candidate" : "capacity_shortfall";

  return {
    ...base,
    status,
    reason: status === "capacity_shortfall" ? "memory_capacity_below_expected_concurrency" : null,
    pm: expectedConcurrency <= 4 ? "ondemand" : "dynamic",
    max_children: maxChildren,
    max_requests: 300,
    process_idle_timeout_seconds: expectedConcurrency <= 4 ? 10 : null,
    reserved_non_php_mb: reservedNonPhpMb,
    available_for_php_mb: availableForPhpMb,
    worker_budget_mb: workerBudgetMb,
    memory_capacity_children: memoryCapacityChildren,
    confidence: observedWorkerMemorySource === "history_pss" && monitor.summary_version === 2 && monitor.pss_coverage >= 0.9 ? "high" : php.worker_count > 0 ? "medium" : "low",
  };
}

export function analyzeAudit(audit, options = {}) {
  if (audit?.schema_version !== "1.0") throw new Error("不支援的 schema_version");
  const findings = [];
  const system = audit.system ?? {};
  const php = audit.php_fpm ?? {};
  const phpMonitor = audit.php_fpm_monitor ?? {};
  const httpMonitor = audit.http_monitor ?? {};
  const oom = audit.oom ?? {};
  const candidate = phpFpmCandidate(system, php, phpMonitor, options.expectedPhpConcurrency);

  if ((oom.count_90d ?? 0) > 0) {
    findings.push(finding("critical", "recent_oom", `近 90 天發生 ${oom.count_90d} 次 OOM`, { count: oom.count_90d, last_event: oom.last_event }, "先找出尖峰請求或程序，量測 PHP-FPM worker PSS/RSS 後再調整設定或規格。"));
  }
  if (system.swap_total_mb === 0 && system.memory_total_mb !== null && system.memory_total_mb < 4096) {
    findings.push(finding("warning", "low_memory_without_swap", "低記憶體主機沒有 swap 緩衝", { memory_total_mb: system.memory_total_mb, swap_total_mb: 0 }, "評估建立受控 swap 作為瞬間尖峰緩衝，並同步監控 swap-in/out；swap 不能取代足夠 RAM。"));
  }
  if ((system.root_disk_used_percent ?? 0) >= 95) {
    findings.push(finding("critical", "root_disk_nearly_full", "根磁碟使用率已達 95% 以上", { used_percent: system.root_disk_used_percent }, "立即確認成長來源、log rotation 與可安全清理項目。"));
  } else if ((system.root_disk_used_percent ?? 0) >= 85) {
    findings.push(finding("warning", "root_disk_high", "根磁碟使用率已達 85% 以上", { used_percent: system.root_disk_used_percent }, "確認成長率、inode、log rotation 與擴容前置時間。"));
  }
  if (system.load_1m !== null && system.cpu_cores !== null && system.load_1m > system.cpu_cores) {
    findings.push(finding("warning", "load_exceeds_cpu", "一分鐘 load 超過 CPU 核心數", { load_1m: system.load_1m, cpu_cores: system.cpu_cores }, "搭配 run queue、iowait 與持續時間判斷 CPU 或 I/O 瓶頸。", "medium"));
  }
  if (php.slowlog_enabled === false && php.service) {
    findings.push(finding("recommendation", "php_slowlog_disabled", "PHP-FPM slow log 尚未啟用", { service: php.service }, "在確認路徑、權限、rotation 與效能影響後，於觀測期間啟用 request_slowlog_timeout。", "high"));
  }
  if (audit.web?.service && audit.web.restart_policy === "no") {
    findings.push(finding("recommendation", "web_restart_disabled", `${audit.web.service} 未設定 systemd 自動重啟`, { service: audit.web.service, restart_policy: "no" }, "先確認既有監控與復原方式，再評估使用適合的 Restart policy；這不是所有環境都必須變更。", "medium"));
  }
  if (audit.wp_cron?.crontab_available && audit.wp_cron.system_trigger_detected === false) {
    findings.push(finding("recommendation", "wp_cron_system_trigger_not_detected", "目前帳號的 crontab 未偵測到 wp-cron", { crontab_available: true }, "確認是否由 systemd timer、其他帳號或外部排程觸發；若仍依賴訪客請求，再評估改為受控排程。", "low"));
  }
  if (php.worker_rss_max_mb && php.max_children && system.memory_total_mb) {
    const projectedMb = Math.round(php.worker_rss_max_mb * php.max_children);
    const ratio = projectedMb / system.memory_total_mb;
    if (ratio > 0.7) {
      findings.push(finding(ratio > 1 ? "critical" : "warning", "php_worker_memory_pressure", "依目前最大 worker RSS 推估，PHP-FPM 記憶體預算偏高", { worker_rss_max_mb: php.worker_rss_max_mb, max_children: php.max_children, projected_mb: projectedMb, memory_total_mb: system.memory_total_mb }, "改以多次尖峰期間的 worker PSS/RSS 分布，扣除 OS、Web Server 與 cache 預算後重算 max_children。", "medium"));
    }
  }

  if (phpMonitor.available) {
    const expectedSamples = phpMonitor.expected_slots;
    const sampleCoverage = phpMonitor.summary_version === 2 && expectedSamples > 0 && Number.isInteger(phpMonitor.covered_slots) && phpMonitor.covered_slots >= 0 && phpMonitor.covered_slots <= expectedSamples ? Math.min(1, phpMonitor.covered_slots / expectedSamples) : null;
    if ((phpMonitor.max_children_reached_delta ?? 0) > 0) {
      findings.push(finding("warning", "php_fpm_max_children_reached", "觀測期間 PHP-FPM 曾達到 max_children", { count_delta: phpMonitor.max_children_reached_delta, active_processes_max: phpMonitor.active_processes_max, configured_max_children: php.max_children }, "先比對同時段 listen queue、RAM、PSS、延遲與 5xx；若記憶體仍有安全餘裕才考慮提高 max_children。", "high"));
    }
    if ((phpMonitor.listen_queue_max ?? 0) > 0) {
      findings.push(finding("warning", "php_fpm_queue_observed", "觀測期間 PHP-FPM listen queue 曾出現等待請求", { listen_queue_max: phpMonitor.listen_queue_max, max_listen_queue_seen: phpMonitor.max_listen_queue_seen, active_processes_max: phpMonitor.active_processes_max }, "確認 queue 是否持續、是否伴隨回應延遲；短暫單點不能單獨支持升規。", "high"));
    }
    if ((phpMonitor.worker_pss_available_samples ?? 0) === 0) {
      findings.push(finding("recommendation", "php_fpm_pss_unavailable", "PHP-FPM 歷史採樣尚未取得 worker PSS", { samples: phpMonitor.samples, rss_sum_max_mb: phpMonitor.worker_rss_sum_max_mb }, "確認 systemd sandbox 與 /proc 權限；PSS 可避免 RSS 共用頁重複計算。", "high"));
    }
    if (sampleCoverage === null || sampleCoverage < 0.9) {
      findings.push(finding("warning", "php_fpm_monitor_coverage_incomplete", "PHP-FPM 尖峰監控 coverage 尚未達 90%", { samples: phpMonitor.samples, expected_samples: expectedSamples, coverage_percent: sampleCoverage === null ? null : Math.round(sampleCoverage * 1000) / 10 }, "持續收集或排查 timer 缺口；coverage 足夠前不據此提出降規。", "high"));
    }
  } else if (php.service) {
    findings.push(finding("recommendation", "php_fpm_peak_history_missing", "尚未取得 PHP-FPM 尖峰歷史", { snapshot_worker_count: php.worker_count, snapshot_worker_rss_max_mb: php.worker_rss_max_mb }, "以 localhost-only status 與低負擔 sampler 收集 active、queue、max children reached、RSS/PSS；不要公開 full status。", "high"));
  }
  if (httpMonitor.available) {
    const expectedHttpSamples = httpMonitor.expected_slots;
    const httpCoverage = httpMonitor.summary_version === 2 && expectedHttpSamples > 0 && Number.isInteger(httpMonitor.covered_slots) && httpMonitor.covered_slots >= 0 && httpMonitor.covered_slots <= expectedHttpSamples ? Math.min(1, httpMonitor.covered_slots / expectedHttpSamples) : null;
    if (httpCoverage === null || httpCoverage < 0.9) {
      findings.push(finding("warning", "http_monitor_coverage_incomplete", "HTTP latency／5xx 監控 coverage 尚未達 90%", { samples: httpMonitor.samples, expected_samples: expectedHttpSamples, coverage_percent: httpCoverage === null ? null : Math.round(httpCoverage * 1000) / 10 }, "先排查 timer 或 log 缺口；coverage 足夠前不依此提出降規。", "high"));
    }
    if ((httpMonitor.requests ?? 0) >= 100 && (httpMonitor.status_5xx_rate_percent ?? 0) >= 1) {
      findings.push(finding("warning", "http_5xx_rate_high", "觀測期間 HTTP 5xx 比例達 1% 以上", { requests: httpMonitor.requests, status_5xx: httpMonitor.status_5xx, rate_percent: httpMonitor.status_5xx_rate_percent }, "比對 PHP queue、OOM、EBS 與事件時段，先找出錯誤原因再評估規格。", "high"));
    }
    if ((httpMonitor.latency_p95_peak_ms ?? 0) >= 3000) {
      findings.push(finding("warning", "http_latency_high", "至少一個採樣區間的 HTTP p95 latency 達 3 秒以上", { latency_p95_peak_ms: httpMonitor.latency_p95_peak_ms, latency_p99_peak_ms: httpMonitor.latency_p99_peak_ms }, "比對 PDF、RDS、PHP queue 與 5xx；單一慢請求不直接等同主機不足。", "medium"));
    }
  } else if (audit.web?.service) {
    findings.push(finding("recommendation", "http_performance_history_missing", "尚未取得匿名 HTTP latency／5xx 歷史", {}, "僅保存 timestamp、status 與 duration 的數值彙總，不收 IP、URL、Cookie 或 request body。", "high"));
  }

  if (candidate.status === "insufficient_data") {
    findings.push(finding("recommendation", "php_fpm_candidate_insufficient_data", "資料不足，尚無法計算 PHP-FPM 設定候選值", { reason: candidate.reason, expected_concurrency: candidate.expected_concurrency, memory_total_mb: candidate.memory_total_mb, worker_memory_mb: candidate.observed_worker_memory_mb, worker_memory_source: candidate.observed_worker_memory_source }, "在 projects 設定 workload.php_fpm.expected_concurrency，並收集尖峰 active 與 worker PSS/RSS；此值是同時 PHP 請求數，不是登入人數。", "high"));
  } else if (candidate.status === "capacity_shortfall") {
    findings.push(finding("warning", "php_fpm_memory_capacity_shortfall", "目前 RAM 無法在保留系統記憶體後支撐預期 PHP 並行數", { expected_concurrency: candidate.expected_concurrency, memory_capacity_children: candidate.memory_capacity_children, worker_budget_mb: candidate.worker_budget_mb, available_for_php_mb: candidate.available_for_php_mb }, "先降低 worker 記憶體、確認尖峰 RSS/PSS，或提高 RAM；不要直接把 max_children 設得高於記憶體容量。", candidate.confidence));
  } else {
    findings.push(finding("recommendation", "php_fpm_candidate_available", "已依 RAM、worker RSS 與預期並行數產生 PHP-FPM 候選值", { pm: candidate.pm, max_children: candidate.max_children, max_requests: candidate.max_requests }, "先在測試站套用、壓測並觀察 queue、max children reached、OOM 與延遲，再人工核准正式站設定。", candidate.confidence));
  }

  findings.push(finding("info", "snapshot_not_enough_for_downsize", "單次快照不足以支持降規", { observation_type: audit.observation?.type ?? "unknown", php_fpm_history_available: phpMonitor.available === true }, "PHP-FPM 歷史可支持 pool 調校，但整機降規仍需至少 14～30 天 CPU、RAM、I/O、網路、延遲、錯誤率與業務尖峰證據。", "high"));
  findings.sort((a, b) => rank[b.severity] - rank[a.severity]);
  return {
    schema_version: "1.0",
    target: audit.target,
    analyzed_at: new Date().toISOString(),
    overall_severity: findings[0]?.severity ?? "info",
    php_fpm_candidate: candidate,
    findings,
  };
}
