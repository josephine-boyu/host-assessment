import { analyzeAwsHistory } from "./analyze-aws-history.mjs";
import { analyzeAudit } from "./analyze.mjs";
import { collectAwsHistory } from "./collect-aws.mjs";
import { collectHost } from "./collect-host.mjs";
import { renderAwsHistoryMarkdown } from "./render-aws-history-markdown.mjs";
import { renderMarkdown } from "./render-markdown.mjs";
import { decideRightsizing14d, renderRightsizingDecision } from "./rightsizing-decision.mjs";
import { parseObservationWindow } from "./observation-window.mjs";

export function safeTargetName(target) {
  const safe = target.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) throw new Error("target 無法轉成安全的報告目錄名稱");
  return safe;
}

export function dailyOutputDirectory(root, target, now = new Date()) {
  return `${root.replace(/[\\/]+$/, "")}/${now.toISOString().slice(0, 10)}/${safeTargetName(target)}`;
}

export async function runDailyAudit(target, options = {}) {
  const now = options.now ?? new Date();
  const window = options.window ? parseObservationWindow(options.window.start, options.window.end, { now }) : null;
  const days = window?.days ?? Number(options.days ?? 14);
  const collectHostFn = options.collectHostFn ?? collectHost;
  const collectAwsHistoryFn = options.collectAwsHistoryFn ?? collectAwsHistory;

  const hostAudit = await collectHostFn(target, { ...options.hostOptions, historyDays: Math.ceil(days), ...(window ? { window, now } : {}) });
  const hostAnalysis = analyzeAudit(hostAudit, options.analysisOptions ?? {});
  const awsHistory = await collectAwsHistoryFn(hostAudit, { days, now, ...(options.awsOptions ?? {}), ...(window ? { window } : {}) });
  const awsAnalysis = analyzeAwsHistory(awsHistory, hostAudit);
  const rightsizingDecision = decideRightsizing14d({ hostAudit, awsHistory, events: options.events ?? [] });

  return {
    hostAudit,
    hostAnalysis,
    hostMarkdown: renderMarkdown(hostAudit, hostAnalysis),
    awsHistory,
    awsAnalysis,
    awsMarkdown: renderAwsHistoryMarkdown(awsHistory, hostAudit, awsAnalysis),
    rightsizingDecision,
    rightsizingMarkdown: renderRightsizingDecision(rightsizingDecision, target),
    manifest: {
      schema_version: "1.0",
      type: window ? "window_audit_manifest" : "daily_audit_manifest",
      ...(window ? { window, scope: "php_http_aws_window; host_configuration_and_90d_oom_are_current_snapshot" } : {}),
      generated_at: now.toISOString(),
      target,
      history_days: days,
      evaluation_stage: awsAnalysis.evaluation_stage,
      operational_action: awsAnalysis.operational_action,
      rightsizing_status: awsAnalysis.rightsizing_status,
      downsize_eligible: awsAnalysis.downsize_eligible,
      decision: rightsizingDecision.decision,
      files: {
        host_audit: "host.json",
        host_analysis: "host-analysis.json",
        host_report: "host-analysis.md",
        aws_history: window ? "aws-history-window.json" : `aws-history-${days}d.json`,
        aws_analysis: window ? "aws-analysis-window.json" : `aws-analysis-${days}d.json`,
        aws_report: window ? "aws-analysis-window.md" : `aws-analysis-${days}d.md`,
        rightsizing_decision: "rightsizing-decision.json",
        rightsizing_report: "rightsizing-decision.md",
      },
    },
  };
}
