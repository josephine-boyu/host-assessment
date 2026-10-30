import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const bashPath = (p) => p.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);
async function summarize(kind, rows, second = [], validSince, window = {}, gaps = [], metadata = {}) {
  await mkdir(".tmp-tests", { recursive: true });
  const root = await mkdtemp(resolve(".tmp-tests/summary-"));
  await writeFile(join(root,"z.tsv"), rows.join("\n")+"\n");
  await writeFile(join(root,"a.tsv"), second.join("\n")+"\n");
  if(gaps.length) await writeFile(join(root,"test.gaps"),gaps.join("\n")+"\n");
  if (kind === "http" && metadata.producer !== null) await writeFile(join(root,"producer-version"), metadata.producer ?? "http-filtered-v1");
  validSince ??= kind === "http" && !metadata.missingStart ? "2026-08-01T00:00:00Z" : undefined;
  if (validSince) await writeFile(join(root,"valid-since"),validSince);
  const result=spawnSync(bash,["-c",'sudo() { shift; if [[ ${FAIL_READ:-} == gaps && $1 == find && $* == *gaps* ]]; then return 1; fi; if [[ ${FAIL_READ:-} == start && $1 == cat && $* == *valid-since* ]]; then cat "${@:2}"; return 1; fi; if [[ ${FAIL_READ:-} == gapcat && $1 == cat && $* == *gaps* ]]; then return 1; fi; "$@"; }; source scripts/monitor-summary.sh; monitor_summary "$1" 1',"test",kind],{
    encoding:"utf8", env:{...process.env,FAIL_READ:metadata.fail ?? "",MONITOR_HISTORY_DIR:bashPath(root),MONITOR_WINDOW_START:window.start??"",MONITOR_WINDOW_END:window.end??"2026-09-02T00:00:00Z"}
  });
  assert.equal(result.status,0,result.stderr);
  return Object.fromEntries(result.stdout.trim().split("\n").map(l=>l.split("=")));
}
function php(time, counter, age, active=2) {
  return [time,age,0,50,128,2,active,4,50,counter,counter,age,2,200000,100000,2,160000,80000,4000000,0].join("\t");
}
const http=(time,n,p95)=>[time,n,n,0,0,0,1,p95,p95,p95].join("\t");
test("sorts rows across files, deduplicates and counts reset increments only in window",async()=>{
  const a=php("2026-09-01T00:00:05Z",5,500);
  const b=php("2026-09-01T00:01:05Z",7,560,3);
  const c=php("2026-09-01T00:02:05Z",1,10);
  const r=await summarize("php",[c,a],[b,a,php("2026-09-02T00:00:00Z",100,5000)]);
  assert.equal(r.samples,"3"); assert.equal(r.duplicate_samples,"1");
  assert.equal(r.counter_resets,"1"); assert.equal(r.max_children_reached_delta,"3");
  assert.equal(r.active_processes_max,"3"); assert.equal(r.max_active_processes_seen,"50");
  assert.equal(r.covered_slots,"3"); assert.equal(r.pss_covered_slots,"1");
  assert.equal(r.expected_slots,"1440"); assert.equal(r.pss_expected_slots,"288");
});

test("HTTP collection gaps are counted only inside the requested window",async()=>{
  const r=await summarize("http",[http("2026-09-01T01:00:00Z",1,10)],[],undefined,{},[
    "2026-08-31T23:59:59Z","2026-09-01T00:00:00Z","2026-09-01T23:59:59Z","2026-09-02T00:00:00Z"
  ]);
  assert.equal(r.collection_gap_count,"2");
});

test("explicit window excludes old deployment peaks and the exclusive end boundary",async()=>{
  const window={start:"2026-09-01T00:01:00Z",end:"2026-09-01T00:07:00Z"};
  const rows=[php("2026-09-01T00:00:00Z",50,500,50),php("2026-09-01T00:01:00Z",0,1,2),php("2026-09-01T00:02:00Z",1,60,3),php("2026-09-01T00:07:00Z",80,500,80)];
  const r=await summarize("php",rows,[],undefined,window);
  assert.equal(r.samples,"2");assert.equal(r.active_processes_max,"3");assert.equal(r.max_children_reached_delta,"1");
  assert.equal(r.expected_slots,"6");assert.equal(r.pss_expected_slots,"2");
  const h=await summarize("http",[http("2026-09-01T00:00:00Z",100,120000000),http("2026-09-01T00:01:00Z",100,120000000),http("2026-09-01T00:02:00Z",10,1000000),http("2026-09-01T00:07:00Z",100,120000000)],[],undefined,window);
  assert.equal(h.requests,"10");assert.equal(h.latency_p95_peak_ms,"1000");
  assert.equal(h.boundary_samples_excluded,"1");
});
test("uses slots rather than raw counts and exposes conflicting and invalid samples",async()=>{
  const t="2026-09-01T01:00:00Z";
  const r=await summarize("php",[php(t,1,50),php(t,2,50),php("2026-09-01T01:00:10Z",3,60),"2026-09-01T02:00:00Z\tbad"]);
  assert.equal(r.covered_slots,"1"); assert.equal(r.conflicting_samples,"1"); assert.equal(r.invalid_samples,"1");
});
test("HTTP separates a single low-volume slow request from sustained eligible slow slots",async()=>{
  const isolated=await summarize("http",[http("2026-09-01T00:00:00Z",1,120000000)]);
  assert.equal(isolated.latency_p95_peak_ms,"120000"); assert.equal(isolated.latency_slow_samples,"0");
  const rows=Array.from({length:5},(_,i)=>http(`2026-09-01T00:0${i}:00Z`,30,4000000));
  const r=await summarize("http",rows,rows);
  assert.equal(r.requests,"150"); assert.equal(r.latency_slow_consecutive_slots,"5");
  const limited=await summarize("http",rows,[],"2026-09-01T00:03:00Z");
  assert.equal(limited.samples,"2"); assert.equal(limited.expected_slots,"1440");
});

test("HTTP slow streak counts unique slots despite multiple samples and breaks at gaps", async () => {
  const rows = Array.from({length:5},(_,i)=>["05","35"].map(s=>http(`2026-09-01T00:0${i}:${s}Z`,30,4000000))).flat();
  const result = await summarize("http",rows);
  assert.equal(result.covered_slots,"5");
  assert.equal(result.latency_slow_samples,"10");
  assert.equal(result.latency_slow_consecutive_slots,"5");
  const gap = await summarize("http",rows.filter(row=>!row.startsWith("2026-09-01T00:02:")));
  assert.equal(gap.latency_slow_consecutive_slots,"2");
});


test("local-only upgrade cannot certify legacy HTTP history or unreadable metadata", async () => {
  const rows=Array.from({length:1440},(_,i)=>http(new Date(Date.UTC(2026,8,1,0,i)).toISOString().replace(".000Z","Z"),1,10));
  for (const metadata of [{producer:null},{producer:"unknown-v2"},{missingStart:true},{fail:"start"},{fail:"gaps"},{fail:"gapcat"}]) {
    const r=await summarize("http",rows,[],undefined,{},["2026-09-01T01:00:00Z"],metadata);
    assert.equal(r.available,"false",JSON.stringify(metadata));
    assert.equal(r.collection_gap_count,undefined);
    assert.equal(r.coverage,undefined);
  }
  for (const date of ["invalid","2026-02-30T00:00:00Z"]) {
    assert.equal((await summarize("http",rows,[],date)).available,"false");
  }
  const good=await summarize("http",rows);
  assert.equal(good.coverage,"1");assert.equal(good.producer_version,"http-filtered-v1");
});
