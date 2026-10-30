import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,readFile,chmod} from "node:fs/promises";
import {resolve,join} from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";
const bash=process.platform==="win32"?"C:/Program Files/Git/bin/bash.exe":"bash";
const bashPath=p=>p.replaceAll("\\","/").replace(/^([A-Za-z]):\//,(_,d)=>`/${d.toLowerCase()}/`);

test("CloudWatch installation refuses existing package, directory or service before any upload or mutation",async()=>{
  await mkdir(".tmp-tests",{recursive:true});
  const root=await mkdtemp(resolve(".tmp-tests/cwagent-guard-"));
  const ssh=join(root,"ssh.sh");
  await writeFile(ssh,`#!/usr/bin/env bash
set -euo pipefail
rpm() { [[ "$EXISTING" == package ]]; }
systemctl() { [[ "$EXISTING" == service ]]; }
sudo() {
  shift
  if [[ "$1" == true ]]; then return 0; fi
  if [[ "$1" == test && "$2" == -e ]]; then [[ "$EXISTING" == directory ]]; return; fi
  echo 'UNEXPECTED MUTATION' >&2; exit 97
}
curl() { echo 'UNEXPECTED NETWORK' >&2; exit 98; }
eval "\${!#}"
`);
  await chmod(ssh,0o755);
  for(const existing of ["package","directory","service"]){
    const r=spawnSync(bash,[bashPath(resolve("scripts/cloudwatch-agent-install.sh")),"--apply","example"],{
      encoding:"utf8",env:{...process.env,EXISTING:existing,SSH_COMMAND:bashPath(ssh),SCP_COMMAND:"must-not-run-scp"}
    });
    assert.equal(r.status,1,`${existing}: ${r.stderr}`);
    assert.match(r.stderr,/Refusing existing CloudWatch Agent/);
    assert.doesNotMatch(r.stderr,/UNEXPECTED|must-not-run-scp/);
  }
  const source=await readFile("scripts/cloudwatch-agent-install.sh","utf8");
  assert.match(source,/install_command="\$fresh_guard"/);
  assert.match(source,/mktemp -d \/tmp\/ops-toolkit-cwagent/);
});
