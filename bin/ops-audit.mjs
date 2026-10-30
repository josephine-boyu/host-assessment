#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectHost } from "../src/collect-host.mjs";
import { collectAwsHistory } from "../src/collect-aws.mjs";
import { analyzeAwsHistory } from "../src/analyze-aws-history.mjs";
import { analyzeAudit } from "../src/analyze.mjs";
import { renderMarkdown } from "../src/render-markdown.mjs";
import { renderAwsHistoryMarkdown } from "../src/render-aws-history-markdown.mjs";
import { dailyOutputDirectory, runDailyAudit, safeTargetName } from "../src/run-daily.mjs";
import { checkProjects } from "../src/projects-config.mjs";
import { loadProjectsFile, runDailyAll } from "../src/run-daily-all.mjs";
import { loadEvents, recordEvent } from "../src/events.mjs";
import { decideRightsizing14d, renderRightsizingDecision } from "../src/rightsizing-decision.mjs";
import { assess, renderAssessment } from "../src/assess.mjs";
import { parseObservationWindow } from "../src/observation-window.mjs";

function usage() {
  console.log(`用法:
  node bin/ops-audit.mjs collect <ssh-target> <output.json>
  node bin/ops-audit.mjs analyze <input.json> <analysis.json> [report.md]
  node bin/ops-audit.mjs report <ssh-target> [output-prefix]
  node bin/ops-audit.mjs aws-history <host-audit.json> <output.json> [days]
  node bin/ops-audit.mjs aws-analyze <history.json> <host-audit.json> <analysis.json> [report.md]
  node bin/ops-audit.mjs daily <ssh-target> [days] [report-root]
  node bin/ops-audit.mjs window-report <ssh-alias> <start-with-timezone> <end-with-timezone> <new-output-directory>
  node bin/ops-audit.mjs check [projects.json]
  node bin/ops-audit.mjs daily-all [--project <id>] [projects.json] [report-root]
  node bin/ops-audit.mjs mark-event <target> <event> <start|end|point> [event-root]
  node bin/ops-audit.mjs rightsizing-decision <host.json> <aws-history.json> <events.jsonl> <output.json> [report.md]
  node bin/ops-audit.mjs assess <host.json> <aws-history.json> <events.jsonl> <policy.json> <output.json> [report.md]

環境變數:
  SSH_CONFIG       指定非預設 SSH config 路徑
  SSH_COMMAND      指定 ssh 執行檔（Windows 可使用 Git for Windows 的 ssh.exe）
  SSH_IDENTITY_FILE 直接指定私鑰路徑（通常優先使用 SSH config）
  SSH_PORT          SSH port（預設由 SSH config 決定）
  SSH_CONNECT_TIMEOUT  SSH 連線 timeout 秒數（預設 8）
  DAILY_HISTORY_DAYS   daily 預設歷史天數（預設 14）
  PHP_FPM_EXPECTED_CONCURRENCY  預期同時 PHP 請求數；用於候選值計算
  REPORT_DIR           daily 報告根目錄（預設 reports/history）`);
}

async function save(path, content) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, content, "utf8");
}

function collectorOptions() {
  return {
    sshConfig: process.env.SSH_CONFIG,
    sshCommand: process.env.SSH_COMMAND,
    identityFile: process.env.SSH_IDENTITY_FILE,
    port: process.env.SSH_PORT,
    connectTimeout: Number(process.env.SSH_CONNECT_TIMEOUT || 8),
  };
}

function analysisOptions() {
  const raw = process.env.PHP_FPM_EXPECTED_CONCURRENCY;
  if (raw === undefined || raw === "") return {};
  const expectedPhpConcurrency = Number(raw);
  if (!Number.isInteger(expectedPhpConcurrency) || expectedPhpConcurrency < 1 || expectedPhpConcurrency > 100) {
    throw new Error("PHP_FPM_EXPECTED_CONCURRENCY 必須是 1 到 100 的整數");
  }
  return { expectedPhpConcurrency };
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "collect" && args.length === 2) {
    const [target, output] = args;
    const audit = collectHost(target, collectorOptions());
    await save(output, `${JSON.stringify(audit, null, 2)}\n`);
    console.log(`已產生原始資料：${output}`);
  } else if (command === "analyze" && (args.length === 2 || args.length === 3)) {
    const [input, analysisOutput, markdownOutput] = args;
    const audit = JSON.parse(await readFile(input, "utf8"));
    const analysis = analyzeAudit(audit, analysisOptions());
    await save(analysisOutput, `${JSON.stringify(analysis, null, 2)}\n`);
    if (markdownOutput) await save(markdownOutput, renderMarkdown(audit, analysis));
    console.log(`已產生分析：${analysisOutput}${markdownOutput ? `、${markdownOutput}` : ""}`);
  } else if (command === "report" && (args.length === 1 || args.length === 2)) {
    const [target, outputPrefix] = args;
    const audit = collectHost(target, collectorOptions());
    const analysis = analyzeAudit(audit, analysisOptions());
    const markdown = renderMarkdown(audit, analysis);
    if (outputPrefix) {
      await save(`${outputPrefix}.json`, `${JSON.stringify(audit, null, 2)}\n`);
      await save(`${outputPrefix}-analysis.json`, `${JSON.stringify(analysis, null, 2)}\n`);
      await save(`${outputPrefix}-analysis.md`, markdown);
      console.log(`已產生完整報告：${outputPrefix}.json、${outputPrefix}-analysis.json、${outputPrefix}-analysis.md`);
    } else {
      process.stdout.write(markdown);
    }
  } else if (command === "aws-history" && (args.length === 2 || args.length === 3)) {
    const [hostInput, output, days = "14"] = args;
    const hostAudit = JSON.parse(await readFile(hostInput, "utf8"));
    const history = await collectAwsHistory(hostAudit, { days: Number(days) });
    await save(output, `${JSON.stringify(history, null, 2)}\n`);
    console.log(`已產生 AWS ${history.window.days} 日歷史：${output}`);
  } else if (command === "aws-analyze" && (args.length === 3 || args.length === 4)) {
    const [historyInput, hostInput, analysisOutput, markdownOutput] = args;
    const history = JSON.parse(await readFile(historyInput, "utf8"));
    const hostAudit = JSON.parse(await readFile(hostInput, "utf8"));
    const analysis = analyzeAwsHistory(history, hostAudit);
    await save(analysisOutput, `${JSON.stringify(analysis, null, 2)}\n`);
    if (markdownOutput) await save(markdownOutput, renderAwsHistoryMarkdown(history, hostAudit, analysis));
    console.log(`已產生 AWS 初評：${analysisOutput}${markdownOutput ? `、${markdownOutput}` : ""}`);
  } else if (command === "daily" && args.length >= 1 && args.length <= 3) {
    const [target, daysArg, rootArg] = args;
    const days = Number(daysArg ?? process.env.DAILY_HISTORY_DAYS ?? 14);
    const root = rootArg ?? process.env.REPORT_DIR ?? "reports/history";
    const now = new Date();
    const events = await loadEvents(`reports/events/${safeTargetName(target)}.jsonl`);
    const result = await runDailyAudit(target, { days, now, events, hostOptions: collectorOptions(), analysisOptions: analysisOptions() });
    const outputDirectory = dailyOutputDirectory(root, target, now);
    const files = result.manifest.files;
    await save(`${outputDirectory}/${files.host_audit}`, `${JSON.stringify(result.hostAudit, null, 2)}\n`);
    await save(`${outputDirectory}/${files.host_analysis}`, `${JSON.stringify(result.hostAnalysis, null, 2)}\n`);
    await save(`${outputDirectory}/${files.host_report}`, result.hostMarkdown);
    await save(`${outputDirectory}/${files.aws_history}`, `${JSON.stringify(result.awsHistory, null, 2)}\n`);
    await save(`${outputDirectory}/${files.aws_analysis}`, `${JSON.stringify(result.awsAnalysis, null, 2)}\n`);
    await save(`${outputDirectory}/${files.aws_report}`, result.awsMarkdown);
    await save(`${outputDirectory}/${files.rightsizing_decision}`, `${JSON.stringify(result.rightsizingDecision, null, 2)}\n`);
    await save(`${outputDirectory}/${files.rightsizing_report}`, result.rightsizingMarkdown);
    await save(`${outputDirectory}/manifest.json`, `${JSON.stringify(result.manifest, null, 2)}\n`);
    console.log(`每日盤點完成：${outputDirectory}`);
  } else if (command === "window-report" && args.length === 4) {
    const [target,start,end,directory]=args;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target)) throw new Error("window-report 必須使用安全的 SSH Host alias");
    const window=parseObservationWindow(start,end);
    // Reserve a fresh directory before contacting either source; never overwrite daily evidence.
    await mkdir(resolve(directory));
    const events=await loadEvents(`reports/events/${safeTargetName(target)}.jsonl`);
    const result=await runDailyAudit(target,{window,events,hostOptions:collectorOptions(),analysisOptions:analysisOptions()});
    const files=result.manifest.files;
    for (const [key,value] of [["host_audit",result.hostAudit],["host_analysis",result.hostAnalysis],["aws_history",result.awsHistory],["aws_analysis",result.awsAnalysis],["rightsizing_decision",result.rightsizingDecision]]) {
      await save(`${directory}/${files[key]}`,JSON.stringify(value,null,2)+"\n");
    }
    for (const [key,value] of [["host_report",result.hostMarkdown],["aws_report",result.awsMarkdown],["rightsizing_report",result.rightsizingMarkdown]]) await save(`${directory}/${files[key]}`,value);
    await save(`${directory}/manifest.json`,JSON.stringify(result.manifest,null,2)+"\n");
    console.log(`指定區間重新彙整完成：${directory}（起點含、終點不含）`);
  } else if (command === "check" && args.length <= 1) {
    const result = await checkProjects(args[0]);
    console.log(`專案設定：${result.configPath}`);
    for (const project of result.projects) {
      console.log(`- ${project.id ?? "(missing id)"}: ${project.enabled ? "enabled" : "disabled"}`);
    }
    for (const item of result.findings) {
      console.log(`[${item.level.toUpperCase()}]${item.project ? ` ${item.project}:` : ""} ${item.message}`);
    }
    const errors = result.findings.filter((item) => item.level === "error").length;
    const warnings = result.findings.filter((item) => item.level === "warning").length;
    console.log(`檢查完成：${errors} errors、${warnings} warnings；未執行遠端或雲端連線`);
    if (errors > 0) process.exitCode = 1;
  } else if (command === "daily-all") {
    const projectOptionIndex = args.indexOf("--project");
    let projectId;
    const positionalArgs = [...args];
    if (projectOptionIndex >= 0) {
      projectId = args[projectOptionIndex + 1];
      if (!projectId || projectId.startsWith("--")) throw new Error("--project 必須指定專案 ID");
      positionalArgs.splice(projectOptionIndex, 2);
    }
    if (positionalArgs.length > 2 || positionalArgs.some((arg) => arg.startsWith("--"))) throw new Error("daily-all 參數格式錯誤");
    const configPath = positionalArgs[0] ?? "config/projects.local.json";
    const reportRoot = positionalArgs[1] ?? process.env.REPORT_DIR ?? "reports/history";
    const preflight = await checkProjects(configPath);
    const errors = preflight.findings.filter((item) => item.level === "error");
    if (errors.length > 0) {
      for (const item of errors) console.error(`[ERROR]${item.project ? ` ${item.project}:` : ""} ${item.message}`);
      throw new Error("projects 設定未通過靜態檢查，未執行任何盤點");
    }
    const config = await loadProjectsFile(configPath);
    if (process.platform === "win32" && !process.env.SSH_COMMAND) {
      console.warn("[WARNING] SSH_COMMAND 未設定，將使用系統預設 ssh；若私鑰 ACL 被 Windows OpenSSH 拒絕，請使用 daily-all.local.cmd 或設定 Git SSH。");
    }
    const result = await runDailyAll(config, { reportRoot, projectId });
    const batchDirectory = `${reportRoot.replace(/[\\/]+$/, "")}/${result.generated_at.slice(0, 10)}`;
    await save(`${batchDirectory}/batch-manifest.json`, `${JSON.stringify(result, null, 2)}\n`);
    for (const item of result.results) console.log(`[${item.status.toUpperCase()}] ${item.id}: ${item.message || item.error}`);
    console.log(`批次盤點完成：${result.succeeded} succeeded、${result.failed} failed；${batchDirectory}/batch-manifest.json`);
    if (result.failed > 0) process.exitCode = 1;
  } else if (command === "mark-event" && (args.length === 3 || args.length === 4)) {
    const [target, event, phase, root = "reports/events"] = args;
    const result = await recordEvent({ root, target, event, phase });
    console.log(`已記錄事件：${result.record.event}/${result.record.phase}；${result.path}`);
  } else if (command === "assess" && (args.length === 5 || args.length === 6)) {
    const [hostPath,historyPath,eventsPath,policyPath,output,markdown]=args;
    const [hostAudit,awsHistory,policy]=await Promise.all([hostPath,historyPath,policyPath].map(async p=>JSON.parse(await readFile(p,"utf8"))));
    const result=assess({hostAudit,awsHistory,events:await loadEvents(eventsPath),policy});
    await save(output,JSON.stringify(result,null,2)+"\n");
    if(markdown) await save(markdown,renderAssessment(result));
    console.log(`分析完成：${output}`);
  } else if (command === "rightsizing-decision" && (args.length === 4 || args.length === 5)) {
    const [hostInput, awsInput, eventsInput, output, reportOutput] = args;
    const [hostAudit, awsHistory, events] = await Promise.all([
      readFile(hostInput, "utf8").then(JSON.parse),
      readFile(awsInput, "utf8").then(JSON.parse),
      loadEvents(eventsInput),
    ]);
    const decision = decideRightsizing14d({ hostAudit, awsHistory, events });
    await save(output, `${JSON.stringify(decision, null, 2)}\n`);
    if (reportOutput) await save(reportOutput, renderRightsizingDecision(decision, hostAudit.target));
    console.log(`已產生 14 天規格決策：${decision.decision}；${output}${reportOutput ? `、${reportOutput}` : ""}`);
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`錯誤：${error.message}`);
  process.exitCode = 1;
}
