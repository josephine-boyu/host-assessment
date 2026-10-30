# 指定區間重新彙整

用於比較部署修正前後，或只分析某段業務操作。`window-report` 重新讀取主機上的數值歷史與 CloudWatch；不裁切既有每日彙總，也不平均多份報告的 p95。

## 執行方式

沿用既有 SSH alias、AWS 唯讀 profile 與本機環境設定。下面示範台北時間 10/20 00:00 起，到 10/30 00:00 之前的 10 天；此命令會連線指定主機及 AWS，請在已授權範圍內執行：

```powershell
node bin/ops-audit.mjs window-report example-wp-production `
  "2026-10-20T00:00:00+08:00" `
  "2026-10-30T00:00:00+08:00" `
  reports/post-deploy-window
```

- 起點包含、終點不包含；必須提供 `Z` 或明確 UTC offset，並對齊整分鐘。日期若指日本時間請用 `+09:00`，不要猜測時區。
- 區間長度最多 35 天，結束不能在未來。長度限制不代表來源仍保留該期間資料。
- 輸出目錄必須不存在，其父目錄須存在。舊每日報告不會被覆寫；若收集失敗，預留目錄可能為空，請改用新目錄重試。
- CloudWatch 若需要 5 分鐘／1 小時粒度，起訖也須對齊該粒度。工具會明確拒絕無法對齊的區間，不會悄悄擴大到部署之前。
- 不會安裝或更新 Agent、sampler、timer，也不會改 PHP／Apache 設定。主機只讀取現存 TSV 並彙整，回傳摘要；AWS 只使用既有唯讀 API。

輸出包含 `host.json`、`host-analysis.json/md`、`aws-history-window.json`、`aws-analysis-window.json/md`、`rightsizing-decision.json/md` 與 `manifest.json`。報告中的 `window` 記錄正規化 UTC 起訖、實際天數與邊界語義。

已取得新資料後，可用 `assess` 產生自己的目標建議：

```powershell
node bin/ops-audit.mjs assess `
  reports/post-deploy-window/host.json `
  reports/post-deploy-window/aws-history-window.json `
  reports/events/example-wp-production.jsonl `
  config/assessment.example.json `
  reports/post-deploy-window/advice.json `
  reports/post-deploy-window/advice.md
```

`assessment.example.json` 是無指定目標模式；指定目標請用自己的 `assessment-target.local.json`。`window-report` 的預設決策仍沿用原先限定範圍的規則，缺少目標容量證據時會標示資料不足。

## 重算範圍與限制

| 資料 | 處理方式 |
| --- | --- |
| PHP active／queue、PSS／RSS | 從保留的 TSV 篩選區間、排序去重、重新取高點；歷史 high-water mark 仍另列，不能當成本區間採樣高點 |
| PHP counters | 自區間內第一個有效樣本起計增量，辨識 reset；不把區間前的累計值算入。起點到首個樣本之間的增量無法精確歸屬 |
| HTTP | 依採樣完成時間篩選數值批次。跨起點的第一批排除並記錄 `boundary_samples_excluded`，避免帶入部署前請求；不是逐請求時間重播，邊界可能少計一個批次 |
| CloudWatch | 依指定起訖重新查詢，分成 UTC 日段，首尾可為部分日；每段 p95 由 CloudWatch 直接計算。區間平均值使用 SampleCount 加權，缺 count 則維持未知 |
| Coverage | 以指定區間計算唯一採樣時槽、PSS 時槽與缺口；CloudWatch 尖峰及 CPU／RAM 用來源粒度時槽，其他聚合用分段時間覆蓋，不代表每個原始秒都有資料 |
| 業務事件 | 從本機事件檔依同一時間範圍比對；不同時區先以時間點比較 |
| OOM、配置與硬體 inventory | 仍是查詢當下快照及既有 90 天 OOM 查詢，不會假裝重建過去的設定或只計入區間內 OOM |
| Crawler | 本功能不重算 crawler 專用歷史；指定區間時不混入原本 rolling 14 天 crawler 摘要 |

少於 14 天可以比較趨勢與風險，但決策仍標示觀測期不足。若歷史檔已被 rotation 刪除，或 CloudWatch 不再保留所需粒度，工具無法補回；coverage 會揭露不足，不能把缺值當零。

CloudWatch 指標保存粒度會隨資料年齡改變；Basic Monitoring 也可能只有較粗粒度。本功能依來源能力使用 60／300／3600 秒，不把五分鐘速率稱為瞬間峰值。規則依據：[GetMetricData](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html)、[MetricStat](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_MetricStat.html)。

這個命令會按 UTC 日段發出 CloudWatch 查詢，因此 API 呼叫量可能比原本一次 14 天批次更多；不新增付費指標或開啟 Detailed Monitoring。雲端查詢仍可能依帳戶計費。

本機測試使用合成 TSV 與 fake AWS clients，涵蓋時區、部分日、排除舊尖峰、首尾邊界、缺口及短視窗。不代表已完成真實主機與 CloudWatch 的端到端驗證。
