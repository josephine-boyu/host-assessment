import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const gitBash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";

function bashPath(path) {
  if (process.platform !== "win32") return path;
  return path.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

test("HTTP sampler aggregates only numeric status and latency with an incremental cursor", async () => {
  const testRoot = resolve(".tmp-tests");
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "http-monitor-"));
  const historyDir = join(root, "history");
  const logFile = join(root, "metrics.log");
  await mkdir(historyDir);
  await writeFile(logFile, "1000 200 100000\n1001 500 4000000\n1002 404 500000\n1003 302 250000\n");
  const script = bashPath(resolve("config/http-metrics-sample.sh"));
  const env = {
    ...process.env,
    HTTP_METRICS_LOG_FILE: bashPath(logFile),
    HTTP_METRICS_HISTORY_DIR: bashPath(historyDir),
  };

  let result = spawnSync(gitBash, [script], { encoding: "utf8", env });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  await appendFile(logFile, "1004 201 750000\n1005 200 12");
  result = spawnSync(gitBash, [script], { encoding: "utf8", env });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const historyFile = (await readdir(historyDir)).find((name) => name.endsWith(".tsv"));
  const content = await readFile(join(historyDir, historyFile), "utf8");
  const [header, first, second] = content.trim().split(/\r?\n/).map((line) => line.split("\t"));
  const firstValues = Object.fromEntries(header.map((name, index) => [name, first[index]]));
  const secondValues = Object.fromEntries(header.map((name, index) => [name, second[index]]));
  assert.equal(firstValues.requests, "4");
  assert.equal(firstValues.status_5xx, "1");
  assert.equal(firstValues.latency_p50_us, "250000");
  assert.equal(firstValues.latency_p95_us, "4000000");
  assert.equal(secondValues.requests, "1");
  assert.equal(secondValues.status_2xx, "1");
  await appendFile(logFile,"3456\n");
  result = spawnSync(gitBash, [script], { encoding: "utf8", env });
  assert.equal(result.status,0,result.stderr);
  const last=(await readFile(join(historyDir,historyFile),"utf8")).trim().split("\n").at(-1).split("\t");
  assert.equal(last[1],"1");assert.equal(last[9],"123456");
  assert.doesNotMatch(content, /uri|cookie|client_ip|user_agent|referer|request_body/i);
});

test("HTTP Apache log format excludes identifying request fields", async () => {
  const config = await readFile(new URL("../config/http-metrics-httpd.conf", import.meta.url), "utf8");
  const logFormat = config.split(/\r?\n/).find((line) => line.startsWith("LogFormat "));
  assert.match(logFormat, /%\{sec\}t %>s %D/);
  assert.doesNotMatch(logFormat, /%h|%a|%r|%U|%q|Referer|User-agent/i);
  assert.match(config, /^GlobalLog "\|\/usr\/sbin\/rotatelogs -f -n 2 -L \/var\/log\/httpd\/ops-toolkit-request-metrics[.]metrics .* 10M" ops_toolkit_metrics env=!ops_toolkit_internal_monitor$/m);
  assert.doesNotMatch(config, /^CustomLog /m);
});

test("HTTP sampler skips oversized backlog, records a gap, and recovers on the next batch", async () => {
  await mkdir(".tmp-tests", {recursive:true});
  const root=await mkdtemp(resolve(".tmp-tests/http-bounded-"));
  const history=join(root,"history"), log=join(root,"metrics");
  await writeFile(log,"1000 200 100000\n".repeat(100000));
  const env={...process.env,HTTP_METRICS_LOG_FILE:bashPath(log),HTTP_METRICS_HISTORY_DIR:bashPath(history)};
  const script=bashPath(resolve("config/http-metrics-sample.sh"));
  const skipped=spawnSync(gitBash,[script],{encoding:"utf8",env});
  assert.equal(skipped.status,1);assert.match(skipped.stderr,/exceeds 1 MiB/);
  let files=await readdir(history);
  assert.ok(files.some(f=>f.endsWith(".gaps")));assert.ok(!files.some(f=>f.endsWith(".tsv")));
  await appendFile(log,"1001 200 100\n");
  const recovered=spawnSync(gitBash,[script],{encoding:"utf8",env});
  assert.equal(recovered.status,0,recovered.stderr);
  files=await readdir(history);
  const rows=(await readFile(join(history,files.find(f=>f.endsWith(".tsv"))),"utf8")).trim().split("\n");
  assert.equal(rows[1].split("\t")[1],"1");
});

test("HTTP metrics raw file avoids Apache's generic *log rotation rule", async () => {
  const expectedPath = "/var/log/httpd/ops-toolkit-request-metrics.metrics";
  const files = await Promise.all([
    readFile(new URL("../config/http-metrics-httpd.conf", import.meta.url), "utf8"),
    readFile(new URL("../config/http-metrics-logrotate.conf", import.meta.url), "utf8"),
    readFile(new URL("../config/http-metrics-monitor.service", import.meta.url), "utf8"),
    readFile(new URL("../config/http-metrics-sample.sh", import.meta.url), "utf8"),
  ]);

  for (const content of files) assert.match(content, new RegExp(expectedPath.replaceAll(".", "[.]")));
  assert.doesNotMatch(expectedPath, /log$/);
});

test("HTTP sampler service is a restricted oneshot", async () => {
  const unit = await readFile(new URL("../config/http-metrics-monitor.service", import.meta.url), "utf8");
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.match(unit, /^MemoryMax=64M$/m);
  assert.match(unit, /^TimeoutStartSec=10s$/m);
});

test("HTTP migration invalidates probe-contaminated history but preserves an already filtered window", async () => {
  await mkdir(".tmp-tests",{recursive:true});
  const root=await mkdtemp(resolve(".tmp-tests/http-migration-"));
  const valid=join(root,"valid-since");
  const installer=await readFile("scripts/http-metrics-monitor.sh","utf8");
  const start=installer.indexOf("if ! sudo -n grep -qx http-filtered-v1");
  assert.ok(start>=0);
  const snippet=installer.slice(start,installer.indexOf("sudo -n chmod 0640",start)).replace(/\\(["$])/g,"$1");
  const script='sudo() { shift; "$@"; };\n'+snippet;
  const env={...process.env,VALID:bashPath(valid),BACKUP:bashPath(root)};
  const old="2000-01-01T00:00:00Z\n";
  await writeFile(valid,old);
  await writeFile(join(root,"httpd.conf"),"GlobalLog legacy ops_toolkit_metrics\n");
  let r=spawnSync(gitBash,["-c",script],{encoding:"utf8",env});
  assert.equal(r.status,0,r.stderr);assert.notEqual(await readFile(valid,"utf8"),old);
  await writeFile(valid,old);
  await writeFile(join(root,"producer-version"),"http-filtered-v1\n");
  await writeFile(join(root,"httpd.conf"),"GlobalLog filtered ops_toolkit_metrics env=!ops_toolkit_internal_monitor\n");
  r=spawnSync(gitBash,["-c",script],{encoding:"utf8",env});
  assert.equal(r.status,0,r.stderr);assert.equal(await readFile(valid,"utf8"),old);
});

test("HTTP installer separates read-only preflight from explicit apply and rollback", async () => {
  const installer = await readFile(new URL("../scripts/http-metrics-monitor.sh", import.meta.url), "utf8");
  assert.match(installer, /--check/);
  assert.match(installer, /--apply/);
  assert.match(installer, /--update/);
  assert.match(installer, /--rollback/);
  assert.match(installer, /\/var\/backups\/ops-toolkit\/http-metrics/);
  assert.match(installer, /apachectl configtest/);
  assert.match(installer, /timer[.]enabled/);
  assert.match(installer, /valid-since/);
  assert.match(installer, /ops-toolkit-request-metrics[.]metrics/);
  assert.doesNotMatch(installer, /wp-config|wp-content|pm[.]max_children|pm[.]max_requests/);
});
