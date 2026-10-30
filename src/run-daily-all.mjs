import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function runChild(command, args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ exitCode: 1, stdout, stderr: error.message }));
    child.on("close", (exitCode) => resolvePromise({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

export async function runDailyAll(config, options = {}) {
  const now = options.now ?? new Date();
  const reportRoot = options.reportRoot ?? "reports/history";
  const runProjectFn = options.runProjectFn ?? runChild;
  const selectedProject = options.projectId
    ? config.projects.find((project) => project.id === options.projectId)
    : null;
  if (options.projectId && !selectedProject) throw new Error(`找不到專案：${options.projectId}`);
  if (selectedProject && !selectedProject.enabled) throw new Error(`專案尚未啟用：${options.projectId}`);
  const enabledProjects = selectedProject
    ? [selectedProject]
    : config.projects.filter((project) => project.enabled && project.include_in_daily_all !== false);
  const results = [];

  for (const project of enabledProjects) {
    if (project.cloud.provider !== "aws") {
      results.push({ id: project.id, target: project.ssh.target, status: "failed", error: `daily-all 尚未支援 provider=${project.cloud.provider}` });
      continue;
    }

    const childResult = await runProjectFn(process.execPath, [
      resolve("bin/ops-audit.mjs"), "daily", project.ssh.target, String(project.history_days), reportRoot,
    ], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(options.env ?? {}),
        AWS_PROFILE: project.cloud.profile,
        ...(project.cloud.region ? { AWS_REGION: project.cloud.region } : {}),
        ...(project.workload?.php_fpm?.expected_concurrency ? { PHP_FPM_EXPECTED_CONCURRENCY: String(project.workload.php_fpm.expected_concurrency) } : {}),
      },
      project,
    });
    results.push({
      id: project.id,
      target: project.ssh.target,
      status: childResult.exitCode === 0 ? "success" : "failed",
      exit_code: childResult.exitCode,
      message: childResult.exitCode === 0 ? childResult.stdout.trim() : childResult.stderr.trim() || childResult.stdout.trim(),
    });
  }

  return {
    schema_version: "1.0",
    type: "daily_all_manifest",
    generated_at: now.toISOString(),
    enabled_projects: enabledProjects.length,
    succeeded: results.filter((result) => result.status === "success").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

export async function loadProjectsFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
