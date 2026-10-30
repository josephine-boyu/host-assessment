import assert from "node:assert/strict";
import test from "node:test";
import { collectHost } from "../src/collect-host.mjs";
import { spawnSync } from "node:child_process";

test("OOM evidence follows journalctl exit status, including empty and partial failed reads", () => {
  let remote;
  collectHost("example", {run:(_c,_a,o)=>{remote=o.input;return {status:0,stdout:"",stderr:""};}});
  const snippet=remote.slice(remote.indexOf('oom_log=""'));
  const bash=process.platform==="win32"?"C:/Program Files/Git/bin/bash.exe":"bash";
  for(const [code,output,available,count] of [
    [0,"",true,0],[0,"kernel: ordinary message",true,0],
    [0,"Out of memory: Killed process 1",true,1],
    [1,"",false,null],[127,"",false,null],[1,"Out of memory: Killed process 1",false,null]
  ]) {
    const fake='emit() { printf "%s\\t%s\\n" "$1" "$2"; }; sudo() { printf "%s\\n" "$JOURNAL_OUTPUT"; return "$JOURNAL_EXIT"; };\n';
    const result=spawnSync(bash,["-c",fake+snippet],{encoding:"utf8",env:{...process.env,JOURNAL_EXIT:String(code),JOURNAL_OUTPUT:output}});
    assert.equal(result.status,0,result.stderr);
    const audit=collectHost("example",{run:()=>({status:0,stdout:result.stdout,stderr:""})});
    assert.equal(audit.oom.query_available,available);assert.equal(audit.oom.count_90d,count);
    if(!available) assert.equal(audit.oom.last_event,null);
  }
  const missing=collectHost("example",{run:()=>({status:0,stdout:"oom_query_available\ttrue\n",stderr:""})});
  assert.equal(missing.oom.count_90d,null);
});

test("maps collector records into schema 1.0 JSON", () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, input: options.input });
    return {
      status: 0,
      stdout: [
        "hostname\texample.internal",
        "uptime_seconds\t86400",
        "cloud_provider\taws",
        "instance_type\tt3.small",
        "cpu_cores\t2",
        "memory_total_mb\t1913",
        "swap_total_mb\t0",
        "crawler_monitor_available\ttrue",
        "crawler_monitor_window_days\t14",
        "crawler_monitor_samples\t288",
        "crawler_mem_available_min_mb\t500.5",
        "crawler_process_count_max\t7",
        "crawler_rss_sum_max_mb\t220.2",
        "php_max_children\t5",
        "php_slowlog_enabled\tfalse",
        "php_fpm_monitor_available\ttrue",
        "php_fpm_monitor_window_days\t14",
        "php_fpm_monitor_samples\t20160",
        "php_fpm_listen_queue_max\t2",
        "php_fpm_active_processes_max\t5",
        "php_fpm_max_children_reached_delta\t1",
        "php_fpm_worker_pss_available_samples\t20160",
        "php_fpm_worker_pss_sum_max_mb\t412.5",
        "php_fpm_memory_available_min_mb\t600.5",
        "http_monitor_available\ttrue",
        "http_monitor_window_days\t14",
        "http_monitor_samples\t20160",
        "http_monitor_requests\t1234",
        "http_monitor_collection_gap_count\t2",
        "http_monitor_producer_version\thttp-filtered-v1",
        "http_monitor_valid_since\t2026-08-01T00:00:00Z",
        "http_monitor_status_5xx\t2",
        "http_monitor_status_5xx_rate_percent\t0.1621",
        "http_monitor_latency_p95_peak_ms\t850.5",
        "db_service\tmariadb",
        "db_active\tactive",
        "crontab_available\ttrue",
        "wp_cron_system\ttrue",
        "oom_query_available\ttrue",
        "oom_count_90d\t1",
      ].join("\n"),
      stderr: "",
    };
  };

  const audit = collectHost("example", { run, sshConfig: "C:/ssh/config" });
  assert.equal(audit.schema_version, "1.0");
  assert.equal(audit.system.memory_total_mb, 1913);
  assert.equal(audit.system.uptime_seconds, 86400);
  assert.equal(audit.php_fpm.max_children, 5);
  assert.equal(audit.php_fpm_monitor.samples, 20160);
  assert.equal(audit.php_fpm_monitor.listen_queue_max, 2);
  assert.equal(audit.php_fpm_monitor.max_children_reached_delta, 1);
  assert.equal(audit.php_fpm_monitor.worker_pss_sum_max_mb, 412.5);
  assert.equal(audit.http_monitor.samples, 20160);
  assert.equal(audit.http_monitor.requests, 1234);
  assert.equal(audit.http_monitor.collection_gap_count, 2);
  assert.equal(audit.http_monitor.producer_version, "http-filtered-v1");
  assert.equal(audit.http_monitor.valid_since, "2026-08-01T00:00:00Z");
  assert.equal(audit.http_monitor.latency_p95_peak_ms, 850.5);
  assert.equal(audit.crawler_monitor.samples, 288);
  assert.equal(audit.crawler_monitor.memory_available_min_mb, 500.5);
  assert.equal(audit.crawler_monitor.process_count_max, 7);
  assert.equal(audit.crawler_monitor.process_rss_sum_max_mb, 220.2);
  assert.equal(audit.database.service, "mariadb");
  assert.equal(audit.wp_cron.system_trigger_detected, true);
  assert.equal(audit.oom.count_90d, 1);
  assert.deepEqual(calls[0].args.slice(0, 6), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-F", "C:/ssh/config"]);
  assert.match(calls[0].input, /Out of memory/);
  assert.match(calls[0].input, /monitor_summary "\$kind" 14/);
  assert.match(calls[0].input, /valid_since/);
  assert.doesNotMatch(calls[0].input, /__MONITOR_SUMMARY__|__HISTORY_DAYS__/);
});

test("represents unavailable OOM history as unknown", () => {
  const run = () => ({ status: 0, stdout: "oom_query_available\tfalse\noom_count_90d\t0\n", stderr: "" });
  const audit = collectHost("example", { run });
  assert.equal(audit.oom.query_available, false);
  assert.equal(audit.oom.count_90d, null);
});

test("surfaces SSH failures without producing partial JSON", () => {
  const run = () => ({ status: 255, stdout: "", stderr: "permission denied" });
  assert.throws(() => collectHost("example", { run }), /permission denied/);
});
