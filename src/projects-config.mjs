import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPPORTED_TYPES = new Set(["linux", "wordpress", "crawler"]);
const SUPPORTED_PROVIDERS = new Set(["aws", "gcp", "none"]);

function finding(level, project, message) {
  return { level, project, message };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateProjectsConfig(config) {
  const findings = [];
  if (!isObject(config)) return [finding("error", null, "設定根節點必須是 JSON object")];
  if (config.schema_version !== "1.0") findings.push(finding("error", null, "schema_version 必須是 1.0"));
  if (!Array.isArray(config.projects) || config.projects.length === 0) {
    findings.push(finding("error", null, "projects 必須是至少含一筆資料的 array"));
    return findings;
  }

  const ids = new Set();
  for (const [index, project] of config.projects.entries()) {
    const label = typeof project?.id === "string" && project.id ? project.id : `projects[${index}]`;
    if (!isObject(project)) {
      findings.push(finding("error", label, "專案必須是 JSON object"));
      continue;
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(project.id ?? "")) {
      findings.push(finding("error", label, "id 只能使用小寫英數、連字號與底線"));
    } else if (ids.has(project.id)) {
      findings.push(finding("error", label, "id 不可重複"));
    } else {
      ids.add(project.id);
    }
    if (!SUPPORTED_TYPES.has(project.type)) findings.push(finding("error", label, "type 必須是 linux、wordpress 或 crawler"));
    if (typeof project.enabled !== "boolean") findings.push(finding("error", label, "enabled 必須是 boolean"));
    if (!isObject(project.ssh) || typeof project.ssh.target !== "string" || !project.ssh.target.trim()) {
      findings.push(finding("error", label, "ssh.target 必須是非空白 SSH Host alias"));
    }
    if (!isObject(project.cloud) || !SUPPORTED_PROVIDERS.has(project.cloud.provider)) {
      findings.push(finding("error", label, "cloud.provider 必須是 aws、gcp 或 none"));
    } else if (project.cloud.provider === "aws" && (typeof project.cloud.profile !== "string" || !project.cloud.profile.trim())) {
      findings.push(finding("error", label, "AWS 專案必須設定 cloud.profile"));
    }
    if (!Number.isInteger(project.history_days) || project.history_days < 1 || project.history_days > 90) {
      findings.push(finding("error", label, "history_days 必須是 1 到 90 的整數"));
    }
    if (project.include_in_daily_all !== undefined && typeof project.include_in_daily_all !== "boolean") {
      findings.push(finding("error", label, "include_in_daily_all must be boolean"));
    }
    if (project.workload !== undefined && !isObject(project.workload)) {
      findings.push(finding("error", label, "workload 必須是 JSON object"));
    }
    const phpFpm = isObject(project.workload) ? project.workload.php_fpm : undefined;
    if (phpFpm !== undefined && (!isObject(phpFpm) || !Number.isInteger(phpFpm.expected_concurrency) || phpFpm.expected_concurrency < 1 || phpFpm.expected_concurrency > 100)) {
      findings.push(finding("error", label, "workload.php_fpm.expected_concurrency 必須是 1 到 100 的整數"));
    }
  }
  return findings;
}

export function parseSshAliases(text) {
  const aliases = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const alias of match[1].trim().split(/\s+/)) {
      if (!alias.startsWith("!") && !alias.includes("*") && !alias.includes("?")) aliases.add(alias);
    }
  }
  return aliases;
}

export function parseAwsProfiles(credentialsText = "", configText = "") {
  const profiles = new Set();
  for (const match of credentialsText.matchAll(/^\s*\[([^\]]+)]/gm)) profiles.add(match[1].trim());
  for (const match of configText.matchAll(/^\s*\[profile\s+([^\]]+)]/gm)) profiles.add(match[1].trim());
  if (/^\s*\[default]/m.test(configText)) profiles.add("default");
  return profiles;
}

async function readOptional(path, readFileFn) {
  try {
    return await readFileFn(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function checkProjects(configPath = "config/projects.local.json", options = {}) {
  const readFileFn = options.readFileFn ?? readFile;
  const home = options.home ?? homedir();
  const sshConfigPath = options.sshConfigPath ?? process.env.SSH_CONFIG ?? join(home, ".ssh", "config");
  const awsCredentialsPath = options.awsCredentialsPath ?? process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, ".aws", "credentials");
  const awsConfigPath = options.awsConfigPath ?? process.env.AWS_CONFIG_FILE ?? join(home, ".aws", "config");
  const config = JSON.parse(await readFileFn(configPath, "utf8"));
  const findings = validateProjectsConfig(config);
  if (findings.some((item) => item.level === "error")) return { configPath, projects: config.projects ?? [], findings };

  const sshText = await readOptional(sshConfigPath, readFileFn);
  const credentialsText = await readOptional(awsCredentialsPath, readFileFn);
  const awsConfigText = await readOptional(awsConfigPath, readFileFn);
  const sshAliases = parseSshAliases(sshText ?? "");
  const awsProfiles = parseAwsProfiles(credentialsText ?? "", awsConfigText ?? "");

  if (sshText === null) findings.push(finding("error", null, `找不到 SSH config：${sshConfigPath}`));
  for (const project of config.projects) {
    const missingLevel = project.enabled ? "error" : "warning";
    if (!sshAliases.has(project.ssh.target)) {
      findings.push(finding(missingLevel, project.id, `SSH alias 不存在：${project.ssh.target}`));
    }
    if (project.cloud.provider === "aws" && !awsProfiles.has(project.cloud.profile)) {
      findings.push(finding(missingLevel, project.id, `AWS profile 不存在：${project.cloud.profile}`));
    }
  }
  findings.push(finding("info", null, "靜態檢查未連線 SSH，也未呼叫 AWS/GCP；實際權限與連線能力尚未驗證"));
  return { configPath, projects: config.projects, findings };
}
