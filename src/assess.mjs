import { analyzeAudit } from "./analyze.mjs";
import { analyzeAwsHistory } from "./analyze-aws-history.mjs";
import { decideRightsizing14d } from "./rightsizing-decision.mjs";

export function assess({hostAudit,awsHistory,events=[],policy}) {
  if (!policy || !["recommend","target"].includes(policy.mode)) throw new Error("policy.mode 必須是 recommend 或 target");
  if (policy.mode === "recommend" && policy.target) throw new Error("recommend 模式不接受預設目標，請改用 target");
  if (policy.mode === "target" && (!policy.target || policy.workload !== "wordpress")) throw new Error("target 模式目前只支援 wordpress，且必須提供 target 規格");
  const allowed=["mode","workload","target","required_event","observation_start","observation_end"];
  if (Object.keys(policy).some(k=>!allowed.includes(k))) throw new Error("policy 含未支援欄位");
  const host=analyzeAudit(hostAudit);
  const aws=analyzeAwsHistory(awsHistory,hostAudit);
  const missing=[];
  for(const [key,field] of [["observation_start","start"],["observation_end","end"]]) {
    if(policy[key] !== undefined && (!Number.isFinite(Date.parse(policy[key])) || Date.parse(policy[key])!==Date.parse(awsHistory.window?.[field]))) missing.push(`${key}_does_not_match_evidence_window`);
  }
  let decision=null;
  if(policy.mode === "target") {
    if(typeof policy.required_event !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(policy.required_event)) throw new Error("target 模式必須指定 required_event 業務事件名稱");
    decision=decideRightsizing14d({hostAudit,awsHistory,events,targetProfile:policy.target,requiredEvent:policy.required_event});
    decision.missing.push(...missing);
    if(missing.length) decision.decision="insufficient_data";
  }
  return {
    schema_version:"1.0",mode:policy.mode,workload:policy.workload??"unspecified",
    target:policy.target??null,window:awsHistory.window,decision,
    operational_action:aws.operational_action,
    recommendations:[...(host.findings??[]),...(aws.findings??[])],missing,
    limitations:[
      "recommend 模式提供風險與設定方向，不自動選擇最低價機型。",
      "target 模式目前限 AWS WordPress；容量值來自提供的規格證據，需人工核對來源與時效。",
      "既有摘要不可直接裁切；請用 window-report 重新彙整來源，再用 assess 分析。要求的視窗不符時停止目標結論。",
      "HTTP 慢樣本固定為至少 20 requests 且 p95 >= 3000 ms；連續 5 個分鐘時槽才視為持續惡化。",
      "14 天可提出試降候選；30 天 AWS 趨勢分析屬不同層次，兩者都不是自動變更授權。"
    ],apply_automatically:false
  };
}

export function renderAssessment(result) {
  return ["# 主機分析建議", "",`- 模式：${result.mode}`,`- 目標：${result.target?.instance_type??"未指定；先盤點再建議"}`,`- 結論：${result.decision?.decision??result.operational_action}`,"",
    "## 建議", "", ...result.recommendations.map(f=>`- ${f.summary}：${f.recommendation}`),"",
    "## 限制與缺少資料","",...result.limitations.map(x=>`- ${x}`),...result.missing.map(x=>`- ${x}`),...(result.decision?.missing??[]).map(x=>`- ${x}`),"",
    "## 決策證據","","```json",JSON.stringify(result.decision,null,2),"```",""].join("\n");
}
