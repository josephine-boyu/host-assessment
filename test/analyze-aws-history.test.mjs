import assert from "node:assert/strict";
import test from "node:test";
import { analyzeAwsHistory } from "../src/analyze-aws-history.mjs";
import { renderAwsHistoryMarkdown } from "../src/render-aws-history-markdown.mjs";

function makeHistory(days = 14, overrides = {}) {
  const daily = Array.from({ length: days }, (_, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    metrics: { cpu_avg: 0.6, cpu_p95: 0.92, cpu_max: index === 5 ? 58.95 : 2, network_in: 1000, network_out: 2000, ebs_read_bytes: 3000, ebs_write_bytes: 4000, cpu_credit_min: 548, cpu_surplus_max: 0, cpu_surplus_charged: 0, status_failed: 0 },
  }));
  return {
    schema_version: "1.0",
    type: "aws_cloudwatch_history",
    evaluation_stage: days >= 30 ? "formal_30d" : "preliminary_14d",
    window: { days, start: "2026-08-01T00:00:00.000Z", end: "2026-08-15T00:00:00.000Z" },
    instance: { instance_id: "i-example", instance_type: "t3.small", vcpus: 2, memory_mib: 2048 },
    coverage: Object.fromEntries(Object.keys(daily[0].metrics).map((key) => [key, 1])),
    daily,
    limitations: ["guest memory unavailable"],
    ...overrides,
  };
}

function makeHost(oomCount = 1) {
  return { schema_version: "1.0", target: "staging", cloud: { instance_id: "i-example" }, system: { memory_total_mb: 1913, memory_available_mb: 1300, swap_total_mb: 0 }, oom: { count_90d: oomCount, last_event: "redacted" } };
}

test("keeps low CPU separate from downsize eligibility when OOM exists", () => {
  const analysis = analyzeAwsHistory(makeHistory(), makeHost());
  assert.equal(analysis.operational_action, "tune");
  assert.equal(analysis.rightsizing_status, "insufficient_data");
  assert.equal(analysis.downsize_eligible, false);
  assert.ok(analysis.findings.some(({ code }) => code === "cpu_capacity_available"));
  assert.ok(analysis.findings.some(({ code }) => code === "recent_oom_blocks_downsize"));
  assert.ok(analysis.findings.some(({ code }) => code === "guest_memory_history_missing"));
});

test("flags high sustained CPU and incomplete coverage", () => {
  const history = makeHistory();
  history.daily[3].metrics.cpu_p95 = 88;
  history.coverage.cpu_avg = 0.5;
  const analysis = analyzeAwsHistory(history, makeHost(0));
  assert.ok(analysis.findings.some(({ code }) => code === "sustained_cpu_pressure"));
  assert.ok(analysis.findings.some(({ code }) => code === "cloudwatch_coverage_incomplete"));
});

test("summarizes CWAgent peaks and reports incomplete guest coverage", () => {
  const history = makeHistory();
  history.guest_metrics = { namespace: "CWAgent", discovered: ["disk_used_percent", "mem_used_percent", "swap_used_percent"] };
  history.daily[0].metrics.mem_used_avg = 45;
  history.daily[0].metrics.mem_used_p95 = 82;
  history.daily[0].metrics.mem_used_max = 93;
  history.daily[0].metrics.swap_used_max = 2;
  history.daily[0].metrics.disk_used_max = 61;
  history.coverage.mem_used_avg = 1 / 14;
  history.coverage.mem_used_p95 = 1 / 14;
  history.coverage.mem_used_max = 1 / 14;
  history.coverage.swap_used_max = 1 / 14;
  history.coverage.disk_used_max = 1 / 14;
  const analysis = analyzeAwsHistory(history, makeHost(0));
  assert.equal(analysis.summary.memory_instant_max_peak_percent, 93);
  assert.equal(analysis.summary.swap_used_maximum_percent, 2);
  assert.ok(analysis.findings.some(({ code }) => code === "guest_memory_coverage_incomplete"));
  assert.ok(analysis.findings.some(({ code }) => code === "guest_memory_pressure"));
  assert.ok(!analysis.findings.some(({ code }) => code === "guest_memory_history_missing"));
});

test("treats newly discovered CWAgent memory as collecting instead of missing", () => {
  const history = makeHistory();
  history.guest_metrics = { namespace: "CWAgent", discovered: ["mem_used_percent"] };
  history.coverage.mem_used_max = 0;
  const analysis = analyzeAwsHistory(history, makeHost(0));
  assert.ok(analysis.findings.some(({ code }) => code === "guest_memory_coverage_incomplete"));
  assert.ok(!analysis.findings.some(({ code }) => code === "guest_memory_history_missing"));
});

test("renders summary, daily evidence and limitations", () => {
  const history = makeHistory();
  const host = makeHost();
  const analysis = analyzeAwsHistory(history, host);
  const markdown = renderAwsHistoryMarkdown(history, host, analysis);
  assert.match(markdown, /Rightsizing status：`insufficient_data`/);
  assert.match(markdown, /CPU 平均：0.6%/);
  assert.match(markdown, /RAM 平均／daily p95/);
  assert.match(markdown, /2026-08-01/);
  assert.match(markdown, /CPU 有餘裕不代表 RAM/);
});

test("summarizes EBS latency and reports exceeded performance", () => {
  const history = makeHistory();
  history.ebs = {
    volumes: [{ volume_id: "vol-example", type: "gp3" }],
    daily: [{ date: "2026-08-01", volumes: { "vol-example": { queue_max: 4, read_latency_ms: 8.5, write_latency_ms: 12.5, iops_exceeded: 1, throughput_exceeded: 0, stalled: 0 } } }],
  };
  const analysis = analyzeAwsHistory(history, makeHost(0));
  assert.equal(analysis.summary.ebs_queue_maximum, 4);
  assert.equal(analysis.summary.ebs_read_latency_maximum_ms, 8.5);
  assert.ok(analysis.findings.some(({ code }) => code === "ebs_performance_exceeded"));
});

test("rejects mismatched instances", () => {
  const host = makeHost();
  host.cloud.instance_id = "i-other";
  assert.throws(() => analyzeAwsHistory(makeHistory(), host), /instance_id 不一致/);
});
