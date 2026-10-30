import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const gitBash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";

function bashPath(path) {
  if (process.platform !== "win32") return path;
  return path.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

test("PHP-FPM sampler stores brief numeric metrics without request data", async () => {
  const testRoot = resolve(".tmp-tests");
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "fpm-monitor-"));
  const procRoot = join(root, "proc");
  const historyDir = join(root, "history");
  const binDir = join(root, "bin");
  await Promise.all([mkdir(join(procRoot, "101"), { recursive: true }), mkdir(join(procRoot, "102"), { recursive: true }), mkdir(join(procRoot, "1"), { recursive: true }), mkdir(historyDir), mkdir(binDir)]);

  const status = {
    "accepted conn": 42,
    "listen queue": 2,
    "max listen queue": 4,
    "listen queue len": 511,
    "idle processes": 3,
    "active processes": 2,
    "total processes": 5,
    "max active processes": 4,
    "max children reached": 1,
    "slow requests": 2,
    "start since": 3600,
  };
  const statusFile = join(root, "status.json");
  await writeFile(statusFile, JSON.stringify(status));
  await writeFile(join(procRoot, "meminfo"), "MemAvailable:    1048576 kB\nSwapTotal:       262144 kB\nSwapFree:        196608 kB\n");

  await writeFile(join(procRoot, "1", "status"), "Name:\tphp-fpm\nVmRSS:\t50000 kB\n");
  await writeFile(join(procRoot, "1", "cmdline"), "php-fpm: master process");
  for (const [pid, rss, pss] of [["101", 120000, 80000], ["102", 140000, 90000]]) {
    await writeFile(join(procRoot, pid, "status"), `Name:\tphp-fpm\nVmRSS:\t${rss} kB\n`);
    await writeFile(join(procRoot, pid, "cmdline"), "php-fpm: pool www");
    await writeFile(join(procRoot, pid, "smaps_rollup"), `Pss:\t${pss} kB\n`);
  }

  const fakeJq = join(binDir, "jq");
  await writeFile(fakeJq, `#!/usr/bin/env bash\nfield=\"$4\"\nnode -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d);process.stdin.on(\"end\",()=>{const v=JSON.parse(s)[process.argv[1]];if(typeof v!==\"number\")process.exit(1);process.stdout.write(String(v))})' \"$field\"\n`);
  await chmod(fakeJq, 0o755);

  const script = bashPath(resolve("config/php-fpm-monitor-sample.sh"));
  const result = spawnSync(gitBash, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bashPath(binDir)}:${process.env.PATH}`,
      PHP_FPM_MONITOR_STATUS_FILE: bashPath(statusFile),
      PHP_FPM_MONITOR_PROC_ROOT: bashPath(procRoot),
      PHP_FPM_MONITOR_HISTORY_DIR: bashPath(historyDir),
      PHP_FPM_MONITOR_PSS_MODE: "always",
    },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const [historyFile] = await readdir(historyDir);
  const content = await readFile(join(historyDir, historyFile), "utf8");
  const [header, row] = content.trim().split(/\r?\n/).map((line) => line.split("\t"));
  const values = Object.fromEntries(header.map((name, index) => [name, row[index]]));
  assert.equal(values.listen_queue, "2");
  assert.equal(values.max_children_reached, "1");
  assert.equal(values.worker_count, "2");
  assert.equal(values.worker_rss_sum_kb, "260000");
  assert.equal(values.worker_pss_sum_kb, "170000");
  assert.equal(values.memory_available_kb, "1048576");
  assert.equal(values.swap_used_kb, "65536");
  assert.doesNotMatch(content, /request_uri|request_method|cookie|customer|script_path|php_auth_user/i);
  assert.ok(!content.includes("pool www"));
});

test("systemd unit restricts network, writes and privileges", async () => {
  const unit = await readFile(new URL("../config/php-fpm-monitor.service", import.meta.url), "utf8");
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^IPAddressDeny=any$/m);
  assert.match(unit, /^IPAddressAllow=localhost$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/ops-toolkit\/php-fpm-history$/m);
  assert.match(unit, /^CapabilityBoundingSet=CAP_SYS_PTRACE$/m);
  assert.match(unit, /^MemoryMax=64M$/m);
  assert.match(unit, /^TimeoutStartSec=10s$/m);
});

test("Apache status listener is loopback-only and collector never requests full status", async () => {
  const apache = await readFile(new URL("../config/php-fpm-monitor-httpd.conf", import.meta.url), "utf8");
  const sampler = await readFile(new URL("../config/php-fpm-monitor-sample.sh", import.meta.url), "utf8");
  assert.match(apache, /^Listen 127\.0\.0\.1:9081$/m);
  assert.match(apache, /Require local/);
  assert.doesNotMatch(sampler, /[?&]full(?:\W|$)/);
  assert.match(sampler, /--max-time 2/);
  assert.match(sampler, /PHP_FPM_MONITOR_PSS_MODE:-auto/);
});

test("installer validates, backs up and can roll back without tuning the pool", async () => {
  const installer = await readFile(new URL("../scripts/php-fpm-monitor.sh", import.meta.url), "utf8");
  assert.match(installer, /\/var\/backups\/ops-toolkit\/php-fpm-monitor/);
  assert.match(installer, /php-fpm -t/);
  assert.match(installer, /apachectl configtest/);
  assert.match(installer, /--retry 10 --retry-connrefused --retry-delay 1/);
  assert.match(installer, /monitor-summary[.]sh/);
  assert.match(installer, /--rollback/);
  assert.match(installer, /pm\.status_path = \/ops-toolkit-fpm-status/);
  assert.doesNotMatch(installer, /pm\.max_children\s*=/);
  assert.doesNotMatch(installer, /pm\.max_requests\s*=/);
});
