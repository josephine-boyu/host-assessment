import assert from "node:assert/strict";
import test from "node:test";
import { parseObservationWindow, splitUtcWindow } from "../src/observation-window.mjs";
import { collectHost } from "../src/collect-host.mjs";
import { runDailyAudit } from "../src/run-daily.mjs";
import { hasCompletedEvent } from "../src/events.mjs";
import { summarizeAwsHistory } from "../src/analyze-aws-history.mjs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const now=new Date("2026-10-30T00:00:00Z");

test("normalizes explicit timezone boundaries and splits partial UTC days",()=>{
  const w=parseObservationWindow("2026-10-20T00:00:00+08:00","2026-10-21T01:00:00+08:00",{now});
  assert.equal(w.start,"2026-10-19T16:00:00.000Z");
  assert.equal(w.days,25/24);assert.equal(w.completed_days_only,false);
  assert.deepEqual(splitUtcWindow(w).map(s=>s.seconds),[8*3600,17*3600]);
});
test("rejects absent timezone, impossible dates, injection, reversed or future windows",()=>{
  for(const [start,end] of [
    ["2026-10-20","2026-10-21"],
    ["2026-02-30T00:00:00Z","2026-03-02T00:00:00Z"],
    ["2026-10-20T00:00:01Z","2026-10-21T00:00:00Z"],
    ["'; touch /tmp/invalid; '","2026-10-21T00:00:00Z"],
    ["2026-10-21T00:00:00Z","2026-10-20T00:00:00Z"],
    ["2026-10-20T00:00:00Z","2026-11-01T00:00:00Z"],
    ["2026-01-01T00:00:00Z","2026-10-20T00:00:00Z"]
  ]) assert.throws(()=>parseObservationWindow(start,end,{now}));
});
test("host collector passes only normalized boundaries without modifying installed samplers",()=>{
  const window={start:"2026-10-20T00:00:00+08:00",end:"2026-10-21T00:00:00+08:00"};
  let script;
  const audit=collectHost("example",{window,now,run:(_c,_a,o)=>{script=o.input;return {status:0,stdout:"",stderr:""};}});
  assert.match(script,/MONITOR_WINDOW_START='2026-10-19T16:00:00Z'/);
  assert.match(script,/MONITOR_WINDOW_END='2026-10-20T16:00:00Z'/);
  assert.equal(audit.observation.crawler_window_supported,false);
  assert.equal(audit.observation.oom_window_days,90);
  assert.throws(()=>collectHost("example",{window:{start:"invalid",end:window.end},run:()=>{throw new Error("should not run");}}),/起訖/);
});
test("window pipeline forwards identical boundaries and produces separate file names",async()=>{
  const window=parseObservationWindow("2026-10-20T00:00:00Z","2026-10-29T00:00:00Z",{now});
  const host={schema_version:"1.0",target:"example",cloud:{instance_id:"i-example"},system:{},php_fpm:{},oom:{query_available:true,count_90d:0}};
  const aws={schema_version:"1.0",type:"aws_cloudwatch_history",instance:{instance_id:"i-example",instance_type:"t3.large"},window:{...window,explicit:true},coverage:{},daily:[],limitations:[]};
  const result=await runDailyAudit("example",{window,now,
    collectHostFn:async(_t,o)=>{assert.deepEqual(o.window,window);return host;},
    collectAwsHistoryFn:async(_h,o)=>{assert.deepEqual(o.window,window);return aws;}
  });
  assert.equal(result.manifest.type,"window_audit_manifest");
  assert.equal(result.manifest.files.aws_history,"aws-history-window.json");
  assert.ok(result.rightsizingDecision.missing.includes("observation_window_below_14_days"));
});
test("event markers use instant comparison rather than timezone string ordering",()=>{
  const events=[{target:"example",event:"peak",phase:"point",at:"2026-10-20T08:00:00+08:00"}];
  assert.equal(hasCompletedEvent(events,"peak","2026-10-20T00:00:00Z","2026-10-20T01:00:00Z","example"),true);
  assert.equal(hasCompletedEvent(events,"peak","2026-10-19T00:00:00Z","2026-10-20T00:00:00Z","example"),false);
});
test("partial-day averages require sample counts rather than equal day weighting",()=>{
  const history={window:{explicit:true},daily:[{metrics:{cpu_avg:50,cpu_sample_count:1,mem_used_avg:50,memory_sample_count:1}},{metrics:{cpu_avg:10,cpu_sample_count:3,mem_used_avg:10,memory_sample_count:3}}]};
  assert.equal(summarizeAwsHistory(history).cpu_avg_mean_percent,20);
  delete history.daily[0].metrics.cpu_sample_count;
  assert.equal(summarizeAwsHistory(history).cpu_avg_mean_percent,null);
});

test("CLI refuses an existing output directory before any remote collection",async()=>{
  await mkdir(".tmp-tests",{recursive:true});
  const dir=await mkdtemp(resolve(".tmp-tests/window-cli-"));
  const result=spawnSync(process.execPath,["bin/ops-audit.mjs","window-report","example","2026-01-01T00:00:00Z","2026-01-02T00:00:00Z",dir],{encoding:"utf8",env:{...process.env,SSH_COMMAND:"must-not-be-executed"}});
  assert.equal(result.status,1);assert.match(result.stderr,/EEXIST/);assert.doesNotMatch(result.stderr,/SSH collector/);
});
