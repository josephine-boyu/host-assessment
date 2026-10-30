import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeAudit } from "../src/analyze.mjs";
import { renderMarkdown } from "../src/render-markdown.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/example-wp-staging.json", import.meta.url), "utf8"));

test("detects evidence-backed OOM and low-memory findings", () => {
  const result = analyzeAudit(fixture);
  assert.equal(result.overall_severity, "critical");
  assert.ok(result.findings.some(({ code }) => code === "recent_oom"));
  assert.ok(result.findings.some(({ code }) => code === "low_memory_without_swap"));
  assert.ok(result.findings.some(({ code }) => code === "web_restart_disabled"));
  assert.ok(result.findings.some(({ code }) => code === "snapshot_not_enough_for_downsize"));
});

test("flags PHP-FPM when observed worker memory exceeds its budget", () => {
  const overloaded = structuredClone(fixture);
  overloaded.php_fpm.worker_rss_max_mb = 300;
  const result = analyzeAudit(overloaded);
  assert.ok(result.findings.some(({ code }) => code === "php_worker_memory_pressure"));
});

test("calculates a conservative PHP-FPM candidate from RAM, worker RSS and concurrency", () => {
  const result = analyzeAudit(fixture, { expectedPhpConcurrency: 4 });
  assert.deepEqual(result.php_fpm_candidate, {
    apply_automatically: false,
    expected_concurrency: 4,
    memory_total_mb: 1913,
    observed_worker_rss_max_mb: 181,
    observed_worker_memory_mb: 181,
    observed_worker_memory_source: "snapshot_rss",
    safety_factor: 1.25,
    status: "candidate",
    reason: null,
    pm: "ondemand",
    max_children: 4,
    max_requests: 300,
    process_idle_timeout_seconds: 10,
    reserved_non_php_mb: 670,
    available_for_php_mb: 1243,
    worker_budget_mb: 227,
    memory_capacity_children: 5,
    confidence: "medium",
  });
  assert.ok(result.findings.some(({ code }) => code === "php_fpm_candidate_available"));
});

test("reports a capacity shortfall instead of overcommitting PHP workers", () => {
  const constrained = structuredClone(fixture);
  constrained.system.memory_total_mb = 1024;
  constrained.php_fpm.worker_rss_max_mb = 300;
  const result = analyzeAudit(constrained, { expectedPhpConcurrency: 4 });
  assert.equal(result.php_fpm_candidate.status, "capacity_shortfall");
  assert.equal(result.php_fpm_candidate.max_children, 1);
  assert.ok(result.findings.some(({ code }) => code === "php_fpm_memory_capacity_shortfall"));
});

test("does not guess a candidate without expected PHP concurrency", () => {
  const result = analyzeAudit(fixture);
  assert.equal(result.php_fpm_candidate.status, "insufficient_data");
  assert.equal(result.php_fpm_candidate.reason, "expected_concurrency_missing");
});

test("does not recommend disk action below threshold", () => {
  const result = analyzeAudit(fixture);
  assert.ok(!result.findings.some(({ code }) => code.startsWith("root_disk_")));
});

test("uses PHP-FPM peak history to report queue and saturation without claiming a downsize", () => {
  const monitored = structuredClone(fixture);
  monitored.php_fpm_monitor = {
    available: true,
    window_days: 14,
    samples: 20160,
    summary_version: 2,
    expected_slots: 20160,
    covered_slots: 20160,
    pss_coverage: 1,
    listen_queue_max: 3,
    max_listen_queue_seen: 3,
    active_processes_max: 5,
    max_children_reached_delta: 2,
    worker_pss_available_samples: 20160,
    worker_pss_sum_max_mb: 520,
    worker_pss_one_max_mb: 130,
  };
  const result = analyzeAudit(monitored, { expectedPhpConcurrency: 4 });
  assert.ok(result.findings.some(({ code }) => code === "php_fpm_queue_observed"));
  assert.ok(result.findings.some(({ code }) => code === "php_fpm_max_children_reached"));
  assert.ok(!result.findings.some(({ code }) => code === "php_fpm_monitor_coverage_incomplete"));
  assert.ok(result.findings.some(({ code }) => code === "snapshot_not_enough_for_downsize"));
  assert.equal(result.php_fpm_candidate.observed_worker_memory_source, "history_pss");
  assert.equal(result.php_fpm_candidate.observed_worker_memory_mb, 130);
  assert.equal(result.php_fpm_candidate.confidence, "high");
});

test("renders a readable Markdown report", () => {
  const analysis = analyzeAudit(fixture, { expectedPhpConcurrency: 4 });
  const markdown = renderMarkdown(fixture, analysis);
  assert.match(markdown, /主機分析報告：example-wp-staging/);
  assert.match(markdown, /recent_oom/);
  assert.match(markdown, /收集事實/);
  assert.match(markdown, /Root disk：61%/);
  assert.match(markdown, /Uptime：1 天 0 小時/);
  assert.match(markdown, /WP-Cron system trigger：無法由 crontab 查詢/);
  assert.match(markdown, /不會自動修改主機/);
  assert.match(markdown, /PHP-FPM 設定候選/);
  assert.match(markdown, /pm.max_children=4/);
});

test("missing slot evidence remains unknown rather than zero coverage", () => {
  const audit=structuredClone(fixture);
  audit.php_fpm_monitor={available:true,summary_version:2,expected_slots:20160,samples:20160};
  const result=analyzeAudit(audit);
  const coverage=result.findings.find(f=>f.code==="php_fpm_monitor_coverage_incomplete");
  assert.equal(coverage.evidence.coverage_percent,null);
});

test("rejects an unsupported schema", () => {
  assert.throws(() => analyzeAudit({ schema_version: "2.0" }), /schema_version/);
});
