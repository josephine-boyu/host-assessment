const labels = { critical: "Critical", warning: "Warning", recommendation: "Recommendation", info: "Info" };

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "未知";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days} 天 ${hours} 小時`;
}

export function renderMarkdown(audit, analysis) {
  const value = (input, suffix = "") => input === null || input === undefined ? "未知" : `${input}${suffix}`;
  const lines = [
    `# 主機分析報告：${audit.target}`,
    "",
    `- 收集時間：${audit.collected_at}`,
    `- 分析時間：${analysis.analyzed_at}`,
    `- 整體等級：${labels[analysis.overall_severity]}`,
    `- 雲端規格：${audit.cloud?.provider ?? "未知"} / ${audit.cloud?.instance_type ?? "未知"}`,
    `- CPU / RAM：${audit.system?.cpu_cores ?? "未知"} vCPU / ${audit.system?.memory_total_mb ?? "未知"} MB`,
    "",
    "## 收集事實",
    "",
    `- Hostname：${value(audit.system?.hostname)}`,
    `- OS / Kernel：${value(audit.system?.os)} / ${value(audit.system?.kernel)}`,
    `- Uptime：${formatDuration(audit.system?.uptime_seconds)}`,
    `- Load 1m：${value(audit.system?.load_1m)}`,
    `- Available RAM / Swap：${value(audit.system?.memory_available_mb, " MB")} / ${value(audit.system?.swap_total_mb, " MB")}`,
    `- Root disk：${value(audit.system?.root_disk_used_percent, "%")}`,
    `- Web：${value(audit.web?.service)}（active=${value(audit.web?.active)}, enabled=${value(audit.web?.enabled)}, restart=${value(audit.web?.restart_policy)}）`,
    `- PHP-FPM：${value(audit.php_fpm?.service)}（pm=${value(audit.php_fpm?.pm)}, max_children=${value(audit.php_fpm?.max_children)}, memory_limit=${value(audit.php_fpm?.memory_limit)}）`,
    `- PHP workers：${value(audit.php_fpm?.worker_count)}（RSS avg=${value(audit.php_fpm?.worker_rss_avg_mb, " MB")}, max=${value(audit.php_fpm?.worker_rss_max_mb, " MB")}）`,
    `- PHP slow log：${audit.php_fpm?.slowlog_enabled ? "已啟用" : "未偵測到"}`,
    `- Local DB：${audit.database?.service ? `${audit.database.service}（active=${value(audit.database.active)}）` : "未偵測"}`,
    `- WP-Cron system trigger：${audit.wp_cron?.crontab_available === false ? "無法由 crontab 查詢" : audit.wp_cron?.system_trigger_detected ? "已偵測" : "未偵測"}`,
    `- OOM（${audit.observation?.oom_window_days ?? 90} 天）：${value(audit.oom?.count_90d)}`,
    ...(audit.crawler_monitor?.available ? [
      `- Crawler monitor：${value(audit.crawler_monitor.samples)} samples / ${value(audit.crawler_monitor.window_days)} 天`,
      `- Crawler RAM：available min=${value(audit.crawler_monitor.memory_available_min_mb, " MB")}；process RSS sum max=${value(audit.crawler_monitor.process_rss_sum_max_mb, " MB")}`,
      `- Crawler process/load：count max=${value(audit.crawler_monitor.process_count_max)}；load 1m max=${value(audit.crawler_monitor.load_1m_max)}`,
    ] : []),
    ...(audit.php_fpm_monitor?.available ? [
      `- PHP-FPM monitor：${value(audit.php_fpm_monitor.samples)} samples / ${value(audit.php_fpm_monitor.window_days)} 天`,
      `- PHP coverage（時槽比例）：${value(audit.php_fpm_monitor.coverage)}；PSS coverage：${value(audit.php_fpm_monitor.pss_coverage)}；最大採樣間隔：${value(audit.php_fpm_monitor.max_sample_gap_seconds, " s")}`,
      `- PHP-FPM 尖峰：active=${value(audit.php_fpm_monitor.active_processes_max)}；queue=${value(audit.php_fpm_monitor.listen_queue_max)}；max_children 增量=${value(audit.php_fpm_monitor.max_children_reached_delta)}`,
      `- PHP-FPM 記憶體高點：RSS sum=${value(audit.php_fpm_monitor.worker_rss_sum_max_mb, " MB")}；PSS sum=${value(audit.php_fpm_monitor.worker_pss_sum_max_mb, " MB")}`,
      `- 尖峰時主機餘裕：available RAM min=${value(audit.php_fpm_monitor.memory_available_min_mb, " MB")}；swap used max=${value(audit.php_fpm_monitor.swap_used_max_mb, " MB")}`,
    ] : [`- PHP-FPM monitor：尚無歷史資料`]),
    ...(audit.http_monitor?.available ? [
      `- HTTP monitor：${value(audit.http_monitor.samples)} samples / ${value(audit.http_monitor.window_days)} 天；requests=${value(audit.http_monitor.requests)}`,
      ...(audit.observation?.monitor_window ? [`- 指定區間排除跨起點 HTTP 批次：${value(audit.http_monitor.boundary_samples_excluded)}；依採樣完成時間彙整，非逐請求時間重播。`] : []),
      `- HTTP 5xx：${value(audit.http_monitor.status_5xx)}（${value(audit.http_monitor.status_5xx_rate_percent, "%")}）`,
      `- HTTP latency：p95 peak=${value(audit.http_monitor.latency_p95_peak_ms, " ms")}；p99 peak=${value(audit.http_monitor.latency_p99_peak_ms, " ms")}`,
      `- 上述為採樣區間百分位的最大值，不是全期百分位；符合流量門檻的慢樣本=${value(audit.http_monitor.latency_slow_samples)}，最長連續慢時槽=${value(audit.http_monitor.latency_slow_consecutive_slots)}`,
    ] : [`- HTTP monitor：尚無匿名 latency／5xx 歷史`]),
    "",
    "## PHP-FPM 設定候選",
    "",
  ];
  const candidate = analysis.php_fpm_candidate;
  if (!candidate || candidate.status === "insufficient_data") {
    lines.push(`- 狀態：資料不足（${candidate?.reason ?? "尚未分析"}）`, "- 說明：需提供預期 PHP 並行數，並在有流量時取得 worker RSS；不會用使用者人數直接代替。", "");
  } else {
    lines.push(
      `- 狀態：${candidate.status === "candidate" ? "可供驗證的候選值" : "記憶體容量不足"}`,
      `- 候選設定：pm=${candidate.pm}、pm.max_children=${candidate.max_children ?? "無安全候選"}、pm.max_requests=${candidate.max_requests}`,
      ...(candidate.process_idle_timeout_seconds ? [`- 閒置回收：pm.process_idle_timeout=${candidate.process_idle_timeout_seconds}s`] : []),
      `- 計算：總 RAM ${candidate.memory_total_mb} MB - 非 PHP 保留 ${candidate.reserved_non_php_mb} MB = PHP 可用 ${candidate.available_for_php_mb} MB`,
      `- Worker 預算：${candidate.observed_worker_memory_source} ${candidate.observed_worker_memory_mb} MB × ${candidate.safety_factor} = ${candidate.worker_budget_mb} MB`,
      `- 容量：最多 ${candidate.memory_capacity_children} workers；預期 PHP 並行數 ${candidate.expected_concurrency}`,
      `- 信心：${candidate.confidence}（單次 RSS 快照僅適合作為初始候選）`,
      "- 套用方式：不會自動套用；須先在測試站驗證並準備回滾。",
      "",
    );
  }
  lines.push(
    "## 分析結果",
    "",
  );
  for (const item of analysis.findings) {
    lines.push(`### ${labels[item.severity]}：${item.summary}`, "", `- 代碼：\`${item.code}\``, `- 信心：${item.confidence}`, `- 證據：\`${JSON.stringify(item.evidence)}\``, `- 建議：${item.recommendation}`, "");
  }
  lines.push("## 限制", "", "PHP-FPM 尖峰資料可用來判斷 pool 飽和與 worker 記憶體，但不能單獨支持整機升降規；仍需結合至少 14～30 天 CPU、RAM、I/O、網路、延遲、錯誤率與已知業務尖峰。", "", "本報告只提出唯讀分析與候選建議，不會自動修改主機或雲端資源。設定與規格變更需人工核准並準備回滾。", "");
  return lines.join("\n");
}
