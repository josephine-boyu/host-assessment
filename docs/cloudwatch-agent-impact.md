# CloudWatch Agent 最小化監控：成本與主機影響

最後查核：2026-09-03。以下只根據 AWS 官方文件；價格可能調整，實際部署前仍應在 CloudWatch 定價頁選擇目標 Region 核對。

## 結論

- CloudWatch Agent 沒有另外列出的軟體授權費，但 Agent 發布的作業系統指標屬於 **CloudWatch custom metrics**，不是免費的 EC2 basic monitoring 指標。另可能產生 `PutMetricData`、查詢、Alarm 或 Logs 費用。
- `metrics_collection_interval: 60` 是一分鐘的 standard resolution；只有低於 60 秒才會成為 high-resolution metric。
- 每台只收 `mem_used_percent`、`swap_used_percent` 與 root filesystem 的 `disk_used_percent`，可把資料量與 metric series 壓到很小；仍不能直接宣稱免費，因為免費額度是整個帳號／Region 的共同用量，disk 與 dimensions 也可能把一個名稱展開成多條計費 series。
- AWS 沒有承諾這組設定固定只占多少 CPU 或 RAM。合理預期是小幅常駐負擔，但這是工程推論，不是 AWS 保證；應先在 staging 量測 24～48 小時，再逐台部署。

## 收費方式

AWS 將 Agent 收集的 guest OS 指標視為 custom metrics。CloudWatch 依每個「metric name + 唯一 dimensions 組合」計數，並按實際發布的小時比例計費；單價和免費額度請以目標 Region 的[官方 CloudWatch 定價頁](https://aws.amazon.com/cloudwatch/pricing/)為準。該頁目前列出的 Free Tier 包含每月 10 個 custom/detailed metrics 與 100 萬次 API requests，但 `GetMetricData`、`GetInsightRuleReport`、`GetMetricWidgetImage` 不包含在一般 API 免費額度內。

CloudWatch Agent 發布 custom metrics 會使用 `PutMetricData`。官方定價頁目前另列 `PutMetricData` 每 100 萬 requests 收取 USD 0.01；Agent 會批次傳送，不能把「三個 metric、每分鐘一次」直接算成每分鐘三次 API 呼叫。可以用 `AWS/Usage` namespace 的 `CallCount`、`Resource=PutMetricData` 查看實際呼叫量，詳見[CloudWatch usage metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Usage-Metrics.html)。本工具每日讀回歷史資料使用 `GetMetricData`，也應依定價頁另外估算。

高解析度 custom metric 本身與標準解析度採相同 metric 定價，但更短週期通常會增加發布請求，high-resolution alarm 也另有價格。這個用途維持 60 秒即可；AWS 明確說明只有 interval 小於 60 秒才是高解析度，見[Agent 設定欄位](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-Configuration-File-Details.html)及[高解析度情境](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-common-scenarios.html#CloudWatch-Agent-high-resolution-metrics)。

### 本案的 series 數量

若三台主機各自只發布一條 memory、一條 swap、一條 root disk，理論下限是 9 條 series。但實際數量可能更高：

- `disk` 若使用 `resources: ["*"]`，每個 filesystem、partition 或 mount 維度都可能形成不同 series。
- 加入 ImageId、InstanceType、AutoScalingGroupName 或自訂維度，會改變 metric identity。
- `aggregation_dimensions` 會增加 roll-up；預設仍保留原始 series。需要 roll-up 且不需要原始值時，可用 `drop_original_metrics` 降低數量與成本。

CloudWatch 不會跨 custom metric dimensions 自動聚合，而且每個唯一組合視為獨立 metric，詳見[CloudWatch metric concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html#Dimension)。Agent 對 aggregation 與 `drop_original_metrics` 的行為見[設定檔說明](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-Configuration-File-Details.html)。

## 主機負載與效能

AWS 文件說明 Agent 會在每個 collection interval 從作業系統讀取資料、計算並回報；例如 Linux memory 資料來自 `/proc/meminfo`。三個目標指標的定義見[CloudWatch Agent collected metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/metrics-collected-by-CloudWatch-agent.html)。

AWS 官方沒有提供「每 60 秒收三個 metrics」的固定 CPU、RAM、網路 overhead 數字或上限。因此不應承諾零負載，也不應捏造百分比。對本案可驗證的作法是：

1. 先只在 staging 安裝，不同時啟用 logs、traces、StatsD、collectd、procstat 或高解析度。
2. 安裝前記錄 24 小時 baseline；安裝後至少觀察 24～48 小時 Agent process 的 RSS、CPU、傳輸量與應用延遲。
3. 確認沒有可見退化後，再分批安裝 production 與 crawler。
4. 對 `t3.small` 等記憶體較小主機特別檢查 Agent RSS 與 OOM 紀錄。

這種測量是必要的，因為負載會受 Agent 版本、OS、metric 數、filesystem 數、interval 與是否同時收 logs/traces 影響。

## 建議的最小化邊界

部署設定應遵守下列限制：

- 全域 interval 固定 60 秒，`debug: false`。
- metrics-only，不設定 `logs` 或 `traces`。
- memory 只收 `mem_used_percent`。
- swap 只收 `swap_used_percent`。
- disk 只指定 root filesystem `/`，不要使用 `*`。
- 全域 dimensions 原則上只保留 `InstanceId`；不建立 hostname、request ID、URL、container ID 等高 cardinality 維度。
- 不設定 `aggregation_dimensions`，除非已計算新增 roll-up series 的成本。
- `usage_data: false` 可停止 Agent 預設傳送自身 health/performance telemetry；AWS 說明該 telemetry 本身不向使用者收費，因此這是最小化傳輸選項，而非節省 custom metric 費用。

是否安裝 Agent、建立 EC2 IAM instance role 及啟動服務都會修改遠端狀態，必須另行取得使用者授權；本文件只做成本與風險評估。
