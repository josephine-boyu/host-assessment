import assert from "node:assert/strict";
import { access, mkdtemp, readFile, mkdir, writeFile, symlink, readdir, stat, chmod } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { exportPublicCopy } from "../scripts/export-public-copy.mjs";

test("exports a clean public copy without private operational files", async () => {
  await mkdir(".tmp-tests", { recursive: true });
  const root = await mkdtemp(join(resolve(".tmp-tests"), "public-export-"));
  const destination = join(root, "public");
  const result = await exportPublicCopy(process.cwd(), destination);

  assert.ok(result.files > 20);
  assert.match(await readFile(join(destination, "README.md"), "utf8"), /^# Host Assessment/m);
  await assert.rejects(access(join(destination, "STATUS.md")));
  await assert.rejects(access(join(destination, "docs", "private-monitor-migration.md")));
  assert.doesNotMatch(await readFile(join(destination, "docs", "installation-and-impact.md"), "utf8"), /既有 PHP／HTTP monitor 的探測排除遷移/);
  await assert.rejects(access(join(destination, "docs", "monitoring-schedule-inventory.md")));
  await assert.rejects(access(join(destination, ".git")));
  await assert.rejects(access(join(destination, "reports")));
  assert.doesNotMatch(await readFile(join(destination, "AGENTS.md"), "utf8"), /Brain|STATUS[.]md/);
  async function checkLinks(dir) {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const path=join(dir,entry.name);
      if(entry.isDirectory()) await checkLinks(path);
      else if(entry.name.endsWith(".md")) {
        const text=await readFile(path,"utf8");
        for(const match of text.matchAll(/\]\(([^)]+)\)/g)) {
          const link=match[1].split("#")[0];
          if(link && !/^[a-z]+:/i.test(link)) await access(resolve(dirname(path),link));
        }
      }
    }
  }
  await checkLinks(destination);
  const demo=spawnSync(process.execPath,["bin/ops-audit.mjs","analyze","examples/host-snapshot.json","reports/demo.json","reports/demo.md"],{cwd:destination,encoding:"utf8"});
  assert.equal(demo.status,0,demo.stderr);
  assert.match(await readFile(join(destination,"reports/demo.md"),"utf8"),/主機分析報告/);
});

async function fixture(files) {
  await mkdir(".tmp-tests", {recursive:true});
  const root=await mkdtemp(resolve(".tmp-tests/export-security-"));
  await mkdir(join(root,"config"));
  await writeFile(join(root,"config/public-files.json"),JSON.stringify(files));
  return root;
}

test("exported launchers retain safe executable permissions and run directly on POSIX", async () => {
  const root = await fixture(["launch.sh", "cli.mjs", "README.md"]);
  await writeFile(join(root, "launch.sh"), "#!/bin/sh\nprintf 'shell-ok'\n", { mode: 0o755 });
  await writeFile(join(root, "cli.mjs"), "#!/usr/bin/env node\nconsole.log('node-ok');\n", { mode: 0o644 });
  await writeFile(join(root, "README.md"), "plain documentation");
  await chmod(join(root, "README.md"), 0o644);
  const destination = join(root, "out");
  await exportPublicCopy(root, destination);
  assert.equal(await readFile(join(destination, "launch.sh"), "utf8"), await readFile(join(root, "launch.sh"), "utf8"));
  if (process.platform !== "win32") {
    for (const file of ["launch.sh", "cli.mjs"]) {
      assert.equal((await stat(join(destination, file))).mode & 0o7777, 0o755);
      const run = spawnSync(join(destination, file), [], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /(?:shell|node)-ok/);
    }
    assert.equal((await stat(join(destination, "README.md"))).mode & 0o7777, 0o644);
  }
});
test("scans exporter itself and never writes rejected secret bytes",async()=>{
  const root=await fixture(["scripts/export-public-copy.mjs"]);
  await mkdir(join(root,"scripts"));
  await writeFile(join(root,"scripts/export-public-copy.mjs"),"AK"+"IA"+"A".repeat(16));
  await assert.rejects(exportPublicCopy(root,join(root,"out")),/掃描失敗/);
  await assert.rejects(access(join(root,"out")));
});
test("private terms are local, unknown files are excluded, and paths cannot escape",async()=>{
  const root=await fixture(["README.md"]);
  await writeFile(join(root,"README.md"),"private-customer-example");
  await writeFile(join(root,"config/public-export.local.json"),JSON.stringify({forbidden_terms:["private-customer-example"]}));
  await assert.rejects(exportPublicCopy(root,join(root,"out")),/掃描失敗/);
  await writeFile(join(root,"README.md"),"safe");
  await writeFile(join(root,".env"),"private data");
  await exportPublicCopy(root,join(root,"out"));
  await assert.rejects(access(join(root,"out/.env")));
  for(const path of ["docs/.env","docs/secrets.pem","../outside.txt","config/public-export.local.json"]) {
    await writeFile(join(root,"config/public-files.json"),JSON.stringify([path]));
    await assert.rejects(exportPublicCopy(root,join(root,"bad")),/路徑/);
  }
});
test("rejects directory junctions before reading external content",async()=>{
  const root=await fixture(["linked/private.txt"]);
  const external=await mkdtemp(resolve(".tmp-tests/external-"));
  await writeFile(join(external,"private.txt"),"outside");
  await symlink(external,join(root,"linked"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(exportPublicCopy(root,join(root,"out")),/symlink|junction/);
  await assert.rejects(access(join(root,"out")));
});
