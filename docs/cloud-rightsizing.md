# AWS / Google Cloud 主機規格與成本盤點

> 本文件只引用 AWS 與 Google Cloud 官方資料。機型、區域供應與價格會變動，因此工具不應內建單一區域的固定單價；應在產生報告時查詢供應商的 pricing API，並保存查詢日期、區域、作業系統與購買模式。

## 適合 Linux / WordPress 的機型對照

下表是「定位相近」而非效能完全等價；處理器世代、架構、網路與磁碟效能仍須實測。

| 工作負載 | AWS EC2 | Google Compute Engine | 選擇重點 |
| --- | --- | --- | --- |
| 低至中度平均 CPU、偶爾突發的小站或測試站 | T4g（Arm）、T3a/T3（x86） | E2 shared-core（如 `e2-micro`、`e2-small`、`e2-medium`） | 低成本，但持續負載與突發規則需特別監控 |
| 一般正式站、CPU 需要可持續使用 | M 系列；Arm 可評估 M7g，x86 可評估 M7a/M7i | E2 standard 或 N2/N2D standard；Arm 可評估 Tau T2A | standard 類通常約 4 GiB/vCPU，適合作為一般網站起點 |
| PHP-FPM / DB 快取或資料庫明顯受記憶體限制 | R 系列 | E2/N2/N2D highmem | high-memory 類通常約 8 GiB/vCPU；先確認真正的 working set 與尖峰 |
| CPU 密集、記憶體需求較低 | C 系列 | E2/N2/N2D highcpu | 約 1–2 GiB/vCPU；通常不適合曾發生 OOM 且未釐清原因的站台 |

AWS 官方將 T 定義為 burstable general purpose，並列出 T4g、T3a、T3；固定 CPU 工作負載應改看一般用途 M、運算最佳化 C 或記憶體最佳化 R。各實例的 vCPU、記憶體與限制應由 [EC2 instance type specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-type-specifications.html) 即時取得，而非由本工具複製一份容易過期的表。

Google Cloud 官方將 E2、N2、N2D、Tau T2A/T2D 歸入 general-purpose family，並提供 standard、highmem、highcpu 與 custom 等比例選項；目前規格與區域限制以 [General-purpose machine family](https://cloud.google.com/compute/docs/general-purpose-machines) 和 [Machine families comparison guide](https://cloud.google.com/compute/docs/machine-resource) 為準。

### Burstable 不可直接視為同一機制

- EC2 T 系列有明確 CPU credits。低於 baseline 時累積、超過時消耗；Standard 模式耗盡後回落至 baseline。T4g/T3a/T3 預設 Unlimited，長時間高於 baseline 可能產生額外 surplus-credit 費用。盤點至少要包含 `CPUCreditBalance`、`CPUCreditUsage`、`CPUSurplusCreditBalance`、`CPUSurplusCreditsCharged`。詳見 [EC2 burstable key concepts](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html)。
- Compute Engine E2 shared-core 會在實體核心時間切片上運作，且可短暫 burst；它不是 EC2 credit bucket 的一對一等價物。規格、可持續 CPU 與 bursting 限制應依 [E2 shared-core machine types](https://cloud.google.com/compute/docs/general-purpose-machines#e2_shared-core_machine_types) 判斷。
- WordPress 若背景排程、備份、圖片處理或流量尖峰使 CPU 長期維持高檔，不應只因平均 CPU 低就選 burstable/shared-core。曾發生 PHP-FPM OOM 的主機，也不能在沒有長期記憶體資料及程序尖峰資料時直接縮小。

## 價格取得：不要硬編碼區域價格

### AWS

使用 AWS Price List Query API / AWS CLI `pricing`：先以 `describe-services`、`get-attribute-values` 探索合法欄位，再用 `get-products` 查 `AmazonEC2`。官方介面與命令見 [AWS CLI pricing reference](https://docs.aws.amazon.com/cli/latest/reference/pricing/) 與 [`get-products`](https://docs.aws.amazon.com/cli/latest/reference/pricing/get-products.html)。查詢條件至少應明確限制：

- `instanceType`、`location`（不是簡單照抄 region code）
- `operatingSystem=Linux`、`tenancy=Shared`
- `preInstalledSw=NA`、`capacitystatus=Used`
- 購買模式（On-Demand / Savings Plans / Reserved）及計價單位

API 回傳的是 SKU/term 維度資料；工具應解析正確的 On-Demand dimension，並另外計算 EBS、snapshot、流量、Elastic IP、監控與可能的 T Unlimited surplus credits。價格 API 有其支援 endpoint，呼叫位置與商品價格所屬 region 是不同概念。

### Google Cloud

公共牌價使用 [Cloud Billing Catalog API](https://cloud.google.com/billing/v1/how-tos/catalog-api)：先列 services 找到 Compute Engine service ID，再列該服務 SKUs，依 `serviceRegions`、資源描述、usage type 與 pricing expression 篩選。若組織有合約價，應改用可查帳務帳戶適用價格的 [Cloud Billing Pricing API](https://cloud.google.com/billing/docs/how-to/get-pricing-information-api)，而不是把公開牌價當實付價。

Compute Engine 常將 vCPU、RAM、磁碟、網路拆成不同 SKU；因此比較一台 VM 時必須合併同區域、同機型系列的 CPU 與 RAM 成本，另計 Persistent Disk、snapshot、外傳流量、外部 IP、授權與監控。輸出應同時保存 currency、aggregation/usage unit、有效時間與查詢時間。官方網頁價可作人工覆核：[Compute Engine general-purpose pricing](https://cloud.google.com/compute/vm-instance-pricing)。

## Rightsizing 所需長期資料

單次 SSH 快照適合找「當下危險」，不適合作為降規依據。至少跨越一個完整業務週期；有月結、行銷活動或批次工作時，應涵蓋那些尖峰。建議保存 p50、p95、p99、max 與尖峰持續時間，而不是只看平均值：

- CPU：使用率、load/run queue、steal/iowait；EC2 T 額外保存全部 credit 指標。
- 記憶體：available/used、swap 使用與 swap-in/out、OOM kill；程序層保存 PHP-FPM workers 的 RSS/PSS 與高水位。
- 磁碟：容量/inode、IOPS、吞吐、latency/queue；同時比對雲端磁碟的 IOPS/throughput 上限。
- 網路：吞吐、封包/錯誤/丟棄、連線數，以及機型 bandwidth/burst 限制。
- 應用：request rate、p95/p99 latency、5xx、PHP-FPM active/idle/max-active/max-children-reached/slow requests、DB connections/slow queries、cache hit ratio。

AWS EC2 預設指標不包含作業系統記憶體；安裝 CloudWatch Agent 後可收集 `mem_used_percent`、swap、disk 等指標。Compute Optimizer 會分析 CPU、disk、network 等資料，而要把 Linux 記憶體納入建議，需提供帶 `InstanceId` dimension 的 `CWAgent/mem_used_percent`。官方說明見 [EC2 metrics analyzed by Compute Optimizer](https://docs.aws.amazon.com/compute-optimizer/latest/ug/ec2-metrics-analyzed.html) 與 [CloudWatch Agent metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/metrics-collected-by-CloudWatch-agent.html)。

AWS Compute Optimizer 預設分析最近 14 天，偏好設定可用 32 天；付費 enhanced infrastructure metrics 可到 93 天。對具有月週期的工作負載，AWS 明確建議 32 天視窗。詳見 [rightsizing recommendation preferences](https://docs.aws.amazon.com/compute-optimizer/latest/ug/rightsizing-preferences.html)。

Google Compute Engine machine-type recommendations 使用 Cloud Monitoring 最近 8 天的 CPU/記憶體資料；CPU 依 60 秒平均，因此可能漏掉短尖峰。此限制也是本工具仍須保留高解析應用指標與尖峰事件的原因。詳見 [Apply machine type recommendations](https://cloud.google.com/compute/docs/instances/apply-machine-type-recommendations-for-instances)。VM 內記憶體與程序資訊可由 Google 建議的 [Ops Agent](https://cloud.google.com/monitoring/agent/ops-agent) 收集。

## 報告的建議分級

每項結論應附證據視窗、信心程度與回滾方式：

1. **立即風險**：近期 OOM、swap thrashing、磁碟/inode 將滿、T credit 耗盡或 surplus charge、持續 I/O latency、PHP-FPM `max children reached`。
2. **設定建議**：依 worker 實測記憶體估算 `pm.max_children`，並保留 OS、DB、cache 與流量尖峰 headroom；調整前後分開執行與稽核。
3. **升規候選**：在足夠觀測期內仍有資源飽和且應用 SLO 受影響；指出受限資源，推薦同架構的一至兩個候選型號。
4. **降規候選**：p95/p99 及尖峰持續時間均有足夠餘裕、沒有 swap/OOM/credit/IO 風險；先在測試站或可快速回滾的時段縮一級。
5. **架構候選**：若 CPU/記憶體比例不匹配，優先改 family 或 custom machine，而非單純整台放大；Arm 候選必須先驗證 PHP extensions、監控 agent、備份工具與原生套件相容性。

跨雲比較輸出不得只顯示 VM 小時計價。應同列估計月費（使用一致的小時假設）、承諾/折扣前後價格、磁碟、快照、網路、IP、監控、支援與遷移成本，並標註 CPU 架構、SLA/HA 拓撲及區域。供應商推薦可作第二意見，最終仍以實際 SLO、壓測與可回滾變更驗證。
