import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEvents, recordEvent } from "../src/events.mjs";
import { decideRightsizing14d, renderRightsizingDecision } from "../src/rightsizing-decision.mjs";
import { assess } from "../src/assess.mjs";
import { splitUtcWindow } from "../src/observation-window.mjs";

function inputs() {
  const hostAudit = {
    schema_version: "1.0",
    target: "example-wp-production",
    cloud: { instance_id: "i-example" },
    system: { memory_total_mb: 7823 },
    php_fpm_monitor: { available: true, window_days: 14, samples: 20160, worker_pss_available_samples: 4000, listen_queue_max: 0, max_children_reached_delta: 0 },
    http_monitor: { available: true, window_days: 14, samples: 20160, requests: 5000, status_5xx_rate_percent: 0.1, latency_p95_peak_ms: 900 },
    oom: { count_90d: 0 },
  };
  const metrics = { status_failed:0, cpu_avg: 1.4, cpu_p95: 5, cpu_max: 50, mem_used_avg: 20, mem_used_p95: 30, mem_used_max: 36 };
  const awsHistory = {
    schema_version: "1.0",
    type: "aws_cloudwatch_history",
    window: { days: 14, start: "2026-09-01T00:00:00.000Z", end: "2026-09-15T00:00:00.000Z" },
    instance: { instance_id: "i-example", instance_type: "t3.large", memory_mib: 8192 },
    coverage: { status_failed:1, cpu_avg: 1, cpu_p95: 1, cpu_max: 1, mem_used_avg: 1, mem_used_p95: 1, mem_used_max: 1 },
    daily: Array.from({ length: 14 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, "0")}`, metrics: { ...metrics } })),
    ebs: {
      volumes: [{ volume_id: "vol-example", type: "gp3" }],
      coverage: { "vol-example": { queue_max: 1, iops_exceeded: 1, throughput_exceeded: 1 } },
      daily: Array.from({ length: 14 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, "0")}`, volumes: { "vol-example": { queue_max: 1, iops_exceeded: 0, throughput_exceeded: 0, stalled: 0 } } })),
    },
  };
  const events = [
    { event: "pdf-email-test", phase: "start", at: "2026-09-10T01:00:00.000Z" },
    { event: "pdf-email-test", phase: "end", at: "2026-09-10T01:05:00.000Z" },
  ];
  for (const event of events) event.target = hostAudit.target;
  hostAudit.oom.query_available=true;
  hostAudit.php_fpm_monitor.worker_pss_one_max_mb=125;
  hostAudit.php_fpm_monitor.active_processes_max=10;
  for(const monitor of [hostAudit.php_fpm_monitor,hostAudit.http_monitor]) Object.assign(monitor,{
    summary_version:2,window_start:awsHistory.window.start,window_end:awsHistory.window.end,
    covered_slots:20160,expected_slots:20160,max_sample_gap_seconds:65,invalid_samples:0,conflicting_samples:0
  });
  Object.assign(hostAudit.php_fpm_monitor,{pss_covered_slots:4000,pss_expected_slots:4032});
  Object.assign(hostAudit.http_monitor,{latency_slow_samples:0,latency_slow_consecutive_slots:0,collection_gap_count:0,producer_version:"http-filtered-v1",valid_since:"2026-08-01T00:00:00Z"});
  awsHistory.instance.vcpus=2;
  awsHistory.comparison_instance_types={"t3.medium":{
    instance_type:"t3.medium",memory_mib:4096,vcpus:2,cpu_baseline_percent:20,
    network_baseline_mib_s:100,ebs_baseline_iops:3000,ebs_baseline_mib_s:125,
    compatibility_verified:true,evidence_source:"synthetic fixture",verified_at:"2026-09-01"
  }};
  for(const day of awsHistory.daily) Object.assign(day.metrics,{network_in_peak_mib_s:1,network_out_peak_mib_s:1,cpu_credit_min:100,cpu_surplus_charged:0});
  for(const key of ["network_in_peak","network_out_peak","cpu_credit_min","cpu_surplus_charged"]) awsHistory.coverage[key]=1;
  for(const day of awsHistory.ebs.daily) Object.assign(day.volumes["vol-example"],{read_iops_peak:10,write_iops_peak:10,read_throughput_mib_s_peak:1,write_throughput_mib_s_peak:1});
  for(const key of ["read_ops_minute","write_ops_minute","read_bytes_minute","write_bytes_minute","read_time_minute","write_time_minute","queue_minute"]) awsHistory.ebs.coverage["vol-example"][key]=1;
  return { hostAudit, awsHistory, events };
}

test("returns a t3.medium trial candidate when coverage, peak and health gates pass", () => {
  const decision = decideRightsizing14d(inputs());
  assert.equal(decision.decision, "t3_medium_trial_candidate");
  assert.equal(decision.evidence.projected_target_memory_percent, 72);
  assert.equal(decision.apply_automatically, false);
  assert.match(renderRightsizingDecision(decision, "production"), /t3_medium_trial_candidate/);
});

test("available exceeded checks cannot bypass independently complete EBS peak evidence",()=>{
  for(const key of ["read_ops_minute","write_ops_minute","read_bytes_minute","write_bytes_minute","read_time_minute","write_time_minute","queue_minute"]) {
    for(const coverage of [undefined,1/1440,NaN,1.1]) {
      const v=inputs();v.awsHistory.ebs.coverage["vol-example"][key]=coverage;
      const r=decideRightsizing14d(v);
      assert.equal(r.decision,"insufficient_data");
      assert.ok(r.missing.includes(`ebs_peak_${key}_coverage_below_90_percent:vol-example`));
    }
  }
});

test("EC2 health failures block default and explicit targets; unknown health is insufficient evidence",()=>{
  const v=inputs();v.awsHistory.daily[0].metrics.status_failed=1;
  let r=decideRightsizing14d(v);
  assert.equal(r.decision,"maintain_t3_large");assert.ok(r.reasons.includes("aws_status_check_failed"));
  r=decideRightsizing14d({...v,targetProfile:v.awsHistory.comparison_instance_types["t3.medium"]});
  assert.equal(r.decision,"maintain_current");
  for(const mutate of [x=>delete x.awsHistory.daily[0].metrics.status_failed,x=>x.awsHistory.coverage.status_failed=0.1]){
    const x=inputs();mutate(x);assert.equal(decideRightsizing14d(x).decision,"insufficient_data");
  }
});

test("a fourteen-day window with partial first and last days validates segment boundaries",()=>{
  const v=inputs();
  Object.assign(v.awsHistory.window,{start:"2026-09-01T01:00:00.000Z",end:"2026-09-15T01:00:00.000Z",explicit:true});
  const metrics=v.awsHistory.daily[0].metrics;
  v.awsHistory.daily=splitUtcWindow(v.awsHistory.window).map(s=>({date:s.date,window_start:s.start.toISOString(),window_end:s.end.toISOString(),metrics:{...metrics}}));
  const volumes = v.awsHistory.ebs.daily[0].volumes;
  v.awsHistory.ebs.daily = splitUtcWindow(v.awsHistory.window).map(s=>({date:s.date,window_start:s.start.toISOString(),window_end:s.end.toISOString(),volumes:structuredClone(volumes)}));
  for(const m of [v.hostAudit.php_fpm_monitor,v.hostAudit.http_monitor]) Object.assign(m,{window_start:v.awsHistory.window.start,window_end:v.awsHistory.window.end});
  assert.equal(decideRightsizing14d(v).decision,"t3_medium_trial_candidate");
  const wrongEbs=structuredClone(v);
  delete wrongEbs.awsHistory.ebs.daily[0].window_start;
  assert.ok(decideRightsizing14d(wrongEbs).missing.includes("ebs_segment_boundaries_missing_or_mismatched"));
  delete v.awsHistory.daily[0].window_start;
  assert.ok(decideRightsizing14d(v).missing.includes("daily_segment_boundaries_missing_or_mismatched"));
});

test("rejects stale, missing, duplicate EBS dates and events from other hosts", () => {
  for (const mutate of [
    v=>{ v.awsHistory.ebs.daily=[{...v.awsHistory.ebs.daily[0],date:"2000-01-01"}]; },
    v=>{ v.awsHistory.ebs.daily.pop(); },
    v=>{ v.awsHistory.ebs.daily[1]=v.awsHistory.ebs.daily[0]; },
    v=>{ delete v.awsHistory.ebs.daily[0].volumes["vol-example"]; },
    v=>{ v.events.forEach(event=>{event.target="another-host";}); },
    v=>{ v.events.forEach(event=>{delete event.target;}); },
    v=>{ delete v.hostAudit.target; },
    v=>{ v.hostAudit.http_monitor.collection_gap_count=1; },
    v=>{ delete v.hostAudit.http_monitor.collection_gap_count; },
  ]) {
    const value=inputs(); mutate(value);
    assert.equal(decideRightsizing14d(value).decision,"insufficient_data");
  }
});

test("chooses PHP tuning for saturation or unsafe target memory", () => {
  const value = inputs();
  value.hostAudit.php_fpm_monitor.max_children_reached_delta = 1;
  const decision = decideRightsizing14d(value);
  assert.equal(decision.decision, "tune_php_fpm");
  assert.ok(decision.reasons.includes("php_fpm_saturation"));
});

test("maintains t3.large when HTTP or EBS evidence is unhealthy", () => {
  const value = inputs();
  value.hostAudit.http_monitor.status_5xx_rate_percent = 2;
  const decision = decideRightsizing14d(value);
  assert.equal(decision.decision, "maintain_t3_large");
});

test("reports missing evidence instead of guessing", () => {
  const value = inputs();
  value.events = [];
  value.hostAudit.http_monitor.samples = 10;
  value.hostAudit.http_monitor.covered_slots = 10;
  const decision = decideRightsizing14d(value);
  assert.equal(decision.decision, "insufficient_data");
  assert.ok(decision.missing.some((item) => item.startsWith("required_event_missing")));
  assert.ok(decision.missing.includes("http_monitor_coverage_below_90_percent"));
});

test("unknown, stale, conflicting or incomplete evidence never produces a trial candidate",()=>{
  for(const mutate of [
    v=>{v.hostAudit.oom.query_available=false;v.hostAudit.oom.count_90d=null;},
    v=>{v.hostAudit.php_fpm_monitor.pss_covered_slots=1;},
    v=>{v.hostAudit.php_fpm_monitor.covered_slots=30000;},
    v=>{v.hostAudit.http_monitor.conflicting_samples=1;},
    v=>{v.hostAudit.http_monitor.window_end="2026-09-16T00:00:00Z";},
    v=>{delete v.awsHistory.daily[0].metrics.mem_used_max;},
    v=>{delete v.awsHistory.comparison_instance_types;}
  ]) { const v=inputs();mutate(v);assert.equal(decideRightsizing14d(v).decision,"insufficient_data"); }
});
test("retains simultaneous PHP and HTTP reasons even when other evidence is missing",()=>{
  const v=inputs();v.hostAudit.php_fpm_monitor.max_children_reached_delta=1;v.hostAudit.http_monitor.status_5xx_rate_percent=5;
  let result=decideRightsizing14d(v);
  assert.ok(result.reasons.includes("php_fpm_saturation"));assert.ok(result.reasons.includes("http_latency_or_5xx_unhealthy"));
  v.events=[];result=decideRightsizing14d(v);assert.ok(result.reasons.includes("http_latency_or_5xx_unhealthy"));
});
test("one slow minute is contextual; sustained slow slots block a trial",()=>{
  const v=inputs();v.hostAudit.http_monitor.latency_p95_peak_ms=120000;
  assert.equal(decideRightsizing14d(v).decision,"t3_medium_trial_candidate");
  v.hostAudit.http_monitor.latency_slow_consecutive_slots=5;
  assert.equal(decideRightsizing14d(v).decision,"maintain_t3_large");
});
test("supports explicit target and open recommendation without inventing a target",()=>{
  const v=inputs();const r=assess({...v,policy:{mode:"recommend",workload:"wordpress"}});
  assert.equal(r.target,null);assert.equal(r.decision,null);assert.ok(r.recommendations.length>0);
  const policy={mode:"target",workload:"wordpress",required_event:"pdf-email-test",target:v.awsHistory.comparison_instance_types["t3.medium"]};
  assert.equal(assess({...v,policy}).decision.decision,"target_trial_candidate");
  policy.observation_start="2026-09-02T00:00:00Z";
  assert.equal(assess({...v,policy}).decision.decision,"insufficient_data");
});
test("target instance limits are considered separately from volume performance",()=>{
  const v=inputs();v.awsHistory.comparison_instance_types["t3.medium"].ebs_baseline_iops=20;
  const r=decideRightsizing14d(v);assert.equal(r.decision,"maintain_t3_large");assert.ok(r.reasons.includes("target_instance_ebs_headroom_low"));
});

test("uses minute EBS fallback when exceeded-check metrics are not available", () => {
  const value = inputs();
  value.awsHistory.ebs.metric_availability = { "vol-example": { iops_exceeded: "not_available", throughput_exceeded: "not_available" } };
  value.awsHistory.ebs.volumes[0] = { ...value.awsHistory.ebs.volumes[0], provisioned_iops: 3000, provisioned_throughput_mib_s: 125 };
  value.awsHistory.ebs.coverage["vol-example"] = Object.fromEntries(["queue_max", "read_ops_minute", "write_ops_minute", "read_bytes_minute", "write_bytes_minute", "read_time_minute", "write_time_minute", "queue_minute"].map((key) => [key, 1]));
  for (const day of value.awsHistory.ebs.daily) Object.assign(day.volumes["vol-example"], { read_iops_peak: 10, write_iops_peak: 5, read_throughput_mib_s_peak: 1, write_throughput_mib_s_peak: 0.5, queue_minute_peak: 0.1, read_latency_minute_peak_ms: 1, write_latency_minute_peak_ms: 1 });
  const decision = decideRightsizing14d(value);
  assert.equal(decision.decision, "t3_medium_trial_candidate");
  assert.ok(!decision.missing.some((item) => item.includes("exceeded_check")));
});

test("records non-sensitive local event markers as JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "ops-toolkit-events-"));
  const started = await recordEvent({ root, target: "example-wp-production", event: "pdf-email-test", phase: "start", at: new Date("2026-09-10T01:00:00Z") });
  await recordEvent({ root, target: "example-wp-production", event: "pdf-email-test", phase: "end", at: new Date("2026-09-10T01:05:00Z") });
  const events = await loadEvents(started.path);
  assert.equal(events.length, 2);
  assert.deepEqual(Object.keys(events[0]), ["schema_version", "target", "event", "phase", "at"]);
  assert.doesNotMatch(await readFile(started.path, "utf8"), /order|email_address|customer|url/i);
});


test("HTTP summary format alone cannot certify source compatibility",()=>{
  for(const metadata of [{producer_version:undefined},{producer_version:"unsupported"},{valid_since:undefined},{valid_since:"invalid"},{valid_since:"2026-09-02T00:00:00Z"}]) {
    const v=inputs();Object.assign(v.hostAudit.http_monitor,metadata);
    const r=decideRightsizing14d(v);
    assert.equal(r.decision,"insufficient_data");
    assert.ok(r.missing.includes("http_producer_or_valid_start_unverified"));
  }
});
