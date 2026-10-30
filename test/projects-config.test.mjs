import assert from "node:assert/strict";
import test from "node:test";
import { checkProjects, parseAwsProfiles, parseSshAliases, validateProjectsConfig } from "../src/projects-config.mjs";

const validConfig = {
  schema_version: "1.0",
  projects: [{
    id: "example-staging",
    type: "wordpress",
    enabled: true,
    ssh: { target: "example-staging" },
    cloud: { provider: "aws", profile: "readonly", region: "ap-northeast-1" },
    history_days: 14,
    workload: { php_fpm: { expected_concurrency: 4 } },
  }],
};

test("validates supported projects and rejects unsafe or duplicate identifiers", () => {
  assert.deepEqual(validateProjectsConfig(validConfig), []);
  const invalid = structuredClone(validConfig);
  invalid.projects.push({ ...structuredClone(invalid.projects[0]), id: "example-staging", type: "unknown" });
  const messages = validateProjectsConfig(invalid).map((item) => item.message);
  assert.ok(messages.includes("id 不可重複"));
  assert.ok(messages.includes("type 必須是 linux、wordpress 或 crawler"));
});

test("validates expected PHP concurrency", () => {
  const invalid = structuredClone(validConfig);
  invalid.projects[0].workload.php_fpm.expected_concurrency = 0;
  assert.ok(validateProjectsConfig(invalid).some((item) => item.message.includes("expected_concurrency")));
  invalid.projects[0].workload = "invalid";
  assert.ok(validateProjectsConfig(invalid).some((item) => item.message === "workload 必須是 JSON object"));
});

test("parses explicit SSH aliases and AWS named profiles without reading secrets", () => {
  assert.deepEqual([...parseSshAliases("Host first second\nHost *\n  User ubuntu")], ["first", "second"]);
  assert.deepEqual([...parseAwsProfiles("[readonly]\nkey=x", "[default]\n[profile sso-readonly]")], ["readonly", "sso-readonly", "default"]);
});

test("validates optional daily-all inclusion flag", () => {
  const invalid = structuredClone(validConfig);
  invalid.projects[0].include_in_daily_all = "no";
  assert.ok(validateProjectsConfig(invalid).some((item) => item.message.includes("include_in_daily_all")));
});

test("check is static and treats missing references for enabled projects as errors", async () => {
  const files = new Map([
    ["projects.json", JSON.stringify(validConfig)],
    ["ssh-config", "Host another-host\n"],
    ["credentials", "[another-profile]\n"],
    ["aws-config", ""],
  ]);
  const reads = [];
  const result = await checkProjects("projects.json", {
    home: "unused",
    sshConfigPath: "ssh-config",
    awsCredentialsPath: "credentials",
    awsConfigPath: "aws-config",
    readFileFn: async (path) => {
      reads.push(path);
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(path);
    },
  });
  assert.deepEqual(reads, ["projects.json", "ssh-config", "credentials", "aws-config"]);
  assert.equal(result.findings.filter((item) => item.level === "error").length, 2);
  assert.match(result.findings.at(-1).message, /未連線 SSH/);
});

test("missing references for disabled projects remain warnings", async () => {
  const disabled = structuredClone(validConfig);
  disabled.projects[0].enabled = false;
  const result = await checkProjects("projects.json", {
    sshConfigPath: "ssh-config",
    awsCredentialsPath: "credentials",
    awsConfigPath: "aws-config",
    readFileFn: async (path) => path === "projects.json" ? JSON.stringify(disabled) : "",
  });
  assert.equal(result.findings.filter((item) => item.level === "error").length, 0);
  assert.equal(result.findings.filter((item) => item.level === "warning").length, 2);
});
