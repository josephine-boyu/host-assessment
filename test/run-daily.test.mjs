import assert from "node:assert/strict";
import test from "node:test";
import { dailyOutputDirectory, runDailyAudit, safeTargetName } from "../src/run-daily.mjs";

const hostAudit = {
  schema_version: "1.0",
  target: "example",
  collected_at: "2026-09-02T00:00:00.000Z",
  observation: { type: "snapshot", oom_window_days: 90 },
  cloud: { provider: "aws", instance_id: "i-example", instance_type: "t3.small", region: "ap-southeast-1" },
  system: { cpu_cores: 2, memory_total_mb: 1913, memory_available_mb: 1300, swap_total_mb: 0, root_disk_used_percent: 60 },
  web: {},
  php_fpm: { worker_count: 2, worker_rss_max_mb: 181 },
  database: {},
  wp_cron: {},
  oom: { query_available: true, count_90d: 1, last_event: "redacted" },
};

const awsHistory = {
  schema_version: "1.0",
  type: "aws_cloudwatch_history",
  evaluation_stage: "preliminary_14d",
  window: { days: 14, start: "2026-08-19T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" },
  instance: { instance_id: "i-example", instance_type: "t3.small", vcpus: 2, memory_mib: 2048 },
  coverage: { cpu_avg: 1 },
  daily: [{ date: "2026-09-01", metrics: { cpu_avg: 1, cpu_p95: 2, cpu_max: 10, cpu_credit_min: 500, cpu_surplus_charged: 0, status_failed: 0 } }],
  limitations: [],
};

test("runs one daily collection through host and AWS analysis", async () => {
  const calls = [];
  const result = await runDailyAudit("example", {
    days: 14,
    now: new Date("2026-09-02T12:00:00Z"),
    analysisOptions: { expectedPhpConcurrency: 4 },
    collectHostFn: async (target) => { calls.push(`host:${target}`); return structuredClone(hostAudit); },
    collectAwsHistoryFn: async (_host, options) => { calls.push(`aws:${options.days}`); return structuredClone(awsHistory); },
  });
  assert.deepEqual(calls, ["host:example", "aws:14"]);
  assert.equal(result.manifest.operational_action, "tune");
  assert.equal(result.manifest.rightsizing_status, "insufficient_data");
  assert.equal(result.manifest.files.aws_report, "aws-analysis-14d.md");
  assert.equal(result.manifest.files.rightsizing_decision, "rightsizing-decision.json");
  assert.equal(result.rightsizingDecision.decision, "insufficient_data");
  assert.ok(result.rightsizingDecision.missing.includes("unsupported_source_instance_type:t3.small"));
  assert.match(result.awsMarkdown, /AWS 觀測初評/);
  assert.equal(result.hostAnalysis.php_fpm_candidate.max_children, 4);
});

test("builds stable date directories and prevents target path traversal", () => {
  const now = new Date("2026-09-02T23:59:00Z");
  assert.equal(dailyOutputDirectory("reports/history/", "example-wp-staging", now), "reports/history/2026-09-02/example-wp-staging");
  assert.equal(safeTargetName("../../unsafe host"), ".._.._unsafe_host");
  assert.throws(() => safeTargetName("///"), /安全/);
});
