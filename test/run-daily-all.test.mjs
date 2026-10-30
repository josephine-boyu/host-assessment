import assert from "node:assert/strict";
import test from "node:test";
import { runDailyAll } from "../src/run-daily-all.mjs";

const config = {
  schema_version: "1.0",
  projects: [
    { id: "one", type: "wordpress", enabled: true, ssh: { target: "host-one" }, cloud: { provider: "aws", profile: "profile-one", region: "r1" }, history_days: 14, workload: { php_fpm: { expected_concurrency: 4 } } },
    { id: "two", type: "crawler", enabled: true, ssh: { target: "host-two" }, cloud: { provider: "aws", profile: "profile-two", region: "r2" }, history_days: 30 },
    { id: "disabled", type: "linux", enabled: false, ssh: { target: "host-three" }, cloud: { provider: "aws", profile: "profile-three" }, history_days: 14 },
  ],
};

test("runs enabled projects with isolated profiles and continues after failure", async () => {
  const calls = [];
  const result = await runDailyAll(config, {
    now: new Date("2026-09-03T00:15:00Z"),
    reportRoot: "custom-reports",
    env: { SSH_CONFIG: "ssh-config" },
    runProjectFn: async (_command, args, options) => {
      calls.push({ args: args.slice(1), profile: options.env.AWS_PROFILE, region: options.env.AWS_REGION, concurrency: options.env.PHP_FPM_EXPECTED_CONCURRENCY });
      return options.project.id === "one"
        ? { exitCode: 1, stdout: "", stderr: "first failed" }
        : { exitCode: 0, stdout: "second succeeded", stderr: "" };
    },
  });
  assert.deepEqual(calls, [
    { args: ["daily", "host-one", "14", "custom-reports"], profile: "profile-one", region: "r1", concurrency: "4" },
    { args: ["daily", "host-two", "30", "custom-reports"], profile: "profile-two", region: "r2", concurrency: undefined },
  ]);
  assert.equal(result.enabled_projects, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
});

test("records unsupported providers without running them", async () => {
  const unsupported = structuredClone(config);
  unsupported.projects = [{ ...unsupported.projects[0], cloud: { provider: "none" } }];
  const result = await runDailyAll(unsupported, { runProjectFn: async () => { throw new Error("must not run"); } });
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /尚未支援/);
});

test("runs only a selected enabled project", async () => {
  const called = [];
  const result = await runDailyAll(config, {
    projectId: "two",
    runProjectFn: async (_command, _args, options) => {
      called.push(options.project.id);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });
  assert.deepEqual(called, ["two"]);
  assert.equal(result.enabled_projects, 1);
});

test("does not allow a single-project run to bypass enabled=false", async () => {
  await assert.rejects(runDailyAll(config, { projectId: "disabled" }), /尚未啟用/);
  await assert.rejects(runDailyAll(config, { projectId: "missing" }), /找不到專案/);
});

test("excludes opted-out projects from daily-all but allows explicit single-project runs", async () => {
  const optedOut = structuredClone(config);
  optedOut.projects[1].include_in_daily_all = false;
  const batchCalls = [];
  await runDailyAll(optedOut, { runProjectFn: async (_command, _args, options) => {
    batchCalls.push(options.project.id);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  } });
  assert.deepEqual(batchCalls, ["one"]);

  const selectedCalls = [];
  await runDailyAll(optedOut, { projectId: "two", runProjectFn: async (_command, _args, options) => {
    selectedCalls.push(options.project.id);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  } });
  assert.deepEqual(selectedCalls, ["two"]);
});
