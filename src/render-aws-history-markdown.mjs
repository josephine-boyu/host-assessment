const labels = { critical: "Critical", warning: "Warning", recommendation: "Recommendation", info: "Info" };

function number(value, suffix = "") {
  return value === null || value === undefined ? "未知" : `${value}${suffix}`;
}

function decimal(value, suffix = "", digits = 2) {
  return value === null || value === undefined ? "未知" : `${Number(value.toFixed(digits))}${suffix}`;
}

function gib(bytes) {
  return bytes === null || bytes === undefined ? "未知" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function renderAwsHistoryMarkdown(history, hostAudit, analysis) {
  const summary = analysis.summary;
  const lines = [
    `# AWS 觀測初評：${analysis.target}`,
    "",
    `- 觀測區間：${history.window.start} ～ ${history.window.end}`,
    ...(history.window.explicit ? ["- 區間：起點含、終點不含；首尾可為部分 UTC 日。平均值依樣本數加權，p95 峰值是各分段 p95 的最大值，非全期 p95。"] : []),
    `- 階段：${analysis.evaluation_stage}`,
    `- Instance：${history.instance.instance_type} / ${history.instance.vcpus} vCPU / ${history.instance.memory_mib} MiB`,
    `- Operational action：\`${analysis.operational_action}\``,
    `- Rightsizing status：\`${analysis.rightsizing_status}\``,
    `- 可降規：${analysis.downsize_eligible ? "是" : "否"}`,
    "",
    "## 指標摘要",
    "",
    `- CPU 平均：${number(summary.cpu_avg_mean_percent, "%")}`,
    `- Daily p95 峰值：${number(summary.cpu_daily_p95_peak_percent, "%")}`,
    `- 瞬間 max 峰值：${number(summary.cpu_instant_max_peak_percent, "%")}`,
    `- CPU credit 最低：${number(summary.cpu_credit_minimum)}`,
    `- Surplus charged 合計：${number(summary.cpu_surplus_charged_total)}`,
    `- Status check failure 最大值：${number(summary.status_check_failed_maximum)}`,
    `- Network in / out：${gib(summary.network_in_total_bytes)} / ${gib(summary.network_out_total_bytes)}`,
    `- EBS read / write：${gib(summary.ebs_read_total_bytes)} / ${gib(summary.ebs_write_total_bytes)}`,
    `- NetworkIn / NetworkOut 峰值：${number(summary.network_in_peak_mib_s, " MiB/s")} / ${number(summary.network_out_peak_mib_s, " MiB/s")}（來源粒度 ${number(history.peak_metric_period_seconds, " 秒")}）`,
    `- EBS read / write IOPS 峰值：${number(summary.ebs_read_iops_peak)} / ${number(summary.ebs_write_iops_peak)}（${number(history.peak_metric_period_seconds, " 秒區間換算")}）`,
    `- EBS read / write throughput 峰值：${number(summary.ebs_read_throughput_mib_s_peak, " MiB/s")} / ${number(summary.ebs_write_throughput_mib_s_peak, " MiB/s")}（${number(history.peak_metric_period_seconds, " 秒區間換算")}）`,
    `- EBS queue 最大值：${number(summary.ebs_queue_maximum)}`,
    `- EBS read / write latency 最大值：${number(summary.ebs_read_latency_minute_peak_ms, " ms")} / ${number(summary.ebs_write_latency_minute_peak_ms, " ms")}（${number(history.peak_metric_period_seconds, " 秒區間")}）`,
    `- EBS IOPS / throughput exceeded 最大值：${number(summary.ebs_iops_exceeded_maximum)} / ${number(summary.ebs_throughput_exceeded_maximum)}`,
    `- EBS stalled check 最大值：${number(summary.ebs_stalled_maximum)}`,
    `- t3.medium network：${history.comparison_instance_types?.["t3.medium"]?.network_performance ?? "n/a"}（baseline ${number(history.comparison_instance_types?.["t3.medium"]?.baseline_bandwidth_gbps, " Gbps")}；peak ${number(history.comparison_instance_types?.["t3.medium"]?.peak_bandwidth_gbps, " Gbps")}）`,
    ...(history.ebs?.volumes ?? []).map((volume) => `- EBS ${volume.volume_id}：${volume.type ?? "未知"}，額定 ${number(volume.provisioned_iops, " IOPS")} / ${number(volume.provisioned_throughput_mib_s, " MiB/s")}；exceeded-check ${history.ebs?.metric_availability?.[volume.volume_id]?.iops_exceeded ?? "未知"} / ${history.ebs?.metric_availability?.[volume.volume_id]?.throughput_exceeded ?? "未知"}`),
    `- RAM 平均／daily p95 峰值／瞬間 max：${number(summary.memory_used_mean_percent, "%")} / ${number(summary.memory_daily_p95_peak_percent, "%")} / ${number(summary.memory_instant_max_peak_percent, "%")}`,
    `- Swap 使用率最大值：${number(summary.swap_used_maximum_percent, "%")}`,
    `- Root disk 使用率最大值：${number(summary.root_disk_used_maximum_percent, "%")}`,
    `- 最低 coverage：${number(Math.round(analysis.coverage_minimum * 1000) / 10, "%")}`,
    `- SSH RAM snapshot：${number(hostAudit.system?.memory_available_mb, " MB available")} / ${number(hostAudit.system?.memory_total_mb, " MB total")}`,
    `- SSH OOM：${number(hostAudit.oom?.count_90d, " 次（近 90 天）")}`,
    "",
    "## 分析結果",
    "",
  ];

  for (const item of analysis.findings) {
    lines.push(`### ${labels[item.severity]}：${item.summary}`, "", `- 代碼：\`${item.code}\``, `- 信心：${item.confidence}`, `- 證據：\`${JSON.stringify(item.evidence)}\``, `- 建議：${item.recommendation}`, "");
  }

  lines.push("## 每日 CPU / Credit", "", "| UTC 日期 | CPU avg | CPU p95 | CPU max | Credit min | Status failed |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const day of history.daily) {
    const metric = day.metrics;
    lines.push(`| ${day.date} | ${decimal(metric.cpu_avg, "%")} | ${decimal(metric.cpu_p95, "%")} | ${decimal(metric.cpu_max, "%")} | ${decimal(metric.cpu_credit_min)} | ${decimal(metric.status_failed, "", 0)} |`);
  }
  lines.push("", "## 每日 EBS", "", "| UTC 日期 | Volume | Queue max | Read latency max | Write latency max | IOPS exceeded | Throughput exceeded | Stalled |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const day of history.ebs?.daily ?? []) {
    for (const [volumeId, metric] of Object.entries(day.volumes ?? {})) {
      lines.push(`| ${day.date} | ${volumeId} | ${decimal(metric.queue_minute_peak)} | ${decimal(metric.read_latency_minute_peak_ms, " ms")} | ${decimal(metric.write_latency_minute_peak_ms, " ms")} | ${decimal(metric.iops_exceeded, "", 0)} | ${decimal(metric.throughput_exceeded, "", 0)} | ${decimal(metric.stalled, "", 0)} |`);
    }
  }
  lines.push("", "## 每日 Guest RAM / Swap / Root Disk", "", "| UTC 日期 | RAM avg | RAM p95 | RAM max | Swap max | Root disk max |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const day of history.daily) {
    const metric = day.metrics;
    lines.push(`| ${day.date} | ${decimal(metric.mem_used_avg, "%")} | ${decimal(metric.mem_used_p95, "%")} | ${decimal(metric.mem_used_max, "%")} | ${decimal(metric.swap_used_max, "%")} | ${decimal(metric.disk_used_max, "%")} |`);
  }
  lines.push("", "## 限制", "", ...history.limitations.map((item) => `- ${item}`), "- CPU 有餘裕不代表 RAM、PHP-FPM 或整機有降規餘裕。", "- 本報告只提出唯讀分析，不會修改 AWS 或主機。", "");
  return lines.join("\n");
}
