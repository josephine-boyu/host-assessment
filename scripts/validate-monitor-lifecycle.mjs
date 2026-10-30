import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Opt-in only: ordinary npm test must never create privileged containers.
if (!process.argv.includes("--run")) {
  console.log("Usage: node scripts/validate-monitor-lifecycle.mjs --run\nCreates a disposable privileged systemd container; no host mounts, ports or runtime network.");
  process.exit(2);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const name = `ops-toolkit-lifecycle-${process.pid}-${Date.now()}`;
const image = "ops-toolkit-systemd-test:local";
function docker(args, timeout = 300_000) {
  const result = spawnSync("docker", args, { cwd: root, stdio: "inherit", timeout });
  if (result.error || result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.error?.message ?? result.status}`);
}
let created = false;
try {
  docker(["build", "-f", resolve(root, "test/integration/Dockerfile.systemd"), "-t", image, "."], 900_000);
  docker(["run", "-d", "--name", name, "--label", "ops-toolkit.test=monitor-lifecycle", "--privileged", "--cgroupns=private",
    "--network=none", "--memory=1g", "--cpus=2", "--pids-limit=512", "--tmpfs", "/run", "--tmpfs", "/tmp", image]);
  created = true;
  docker(["exec", name, "bash", "/opt/ops-toolkit/test/integration/monitor-lifecycle.sh"], 600_000);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (created) {
    try { docker(["stop", "--time", "10", name]); }
    finally { docker(["rm", "-f", name]); }
  }
}
