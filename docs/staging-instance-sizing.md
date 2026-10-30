# 新加坡區域 WordPress/PHP staging EC2 選型

價格資料查核日期：2026-09-07；以下負載數據是匿名化、取整的教學示例，不是目前主機狀態。
範圍：`ap-southeast-1`、Linux、低流量 WordPress/PHP staging；不含任何主機或 AWS 帳號操作。

## 結論摘要

現有 `t3.small` 的 CPU mean 約1%、p95 約1%，顯示長期 CPU 容量明顯寬裕；約100% 的瞬時最大值則符合 T 系列以 credits 處理短暫尖峰的用途。真正限制目前不是 CPU，而是記憶體風險與證據完整度：RAM mean 約40%、max 約45%，但曾發生 OOM、沒有 swap，且 CWAgent coverage 只有 約30%。因此目前不宜直接把正式建議定為 1 GiB 的 `micro`。

短期基準建議是維持 2 GiB：若必須零架構遷移風險，保留 `t3.small`；若 AMI、PHP extensions、Web server、資料庫 client、備份/監控 agent 與任何 vendor binary 都已驗證 `arm64`，則以 `t4g.small` 做可回復的 staging 試跑。待補足至少一個具代表性的觀測週期、釐清 OOM 根因並驗證 swap/worker 上限後，再把 `t3.micro` 或 `t4g.micro` 列為實驗候選，而不是目前的直接建議。

## 候選規格

| 類型 | 架構 | vCPU | RAM | baseline / vCPU | credits / 小時 | instance storage | 判讀 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `t3.micro` | x86_64（Intel） | 2 | 1 GiB | 10% | 12 | EBS-only | CPU 足夠的可能性高，但 RAM 減半；在既有 OOM 未釐清前風險最高 |
| `t3.small` | x86_64（Intel） | 2 | 2 GiB | 20% | 24 | EBS-only | 現況、相容性風險最低；CPU 過度配置但保留目前記憶體 |
| `t4g.micro` | arm64（Graviton2） | 2 | 1 GiB | 10% | 12 | EBS-only | 最低計算費候選；同時承擔 RAM 減半與架構移植兩種風險 |
| `t4g.small` | arm64（Graviton2） | 2 | 2 GiB | 20% | 24 | EBS-only | 保留 2 GiB，通常是先驗證 Arm、再考慮降 RAM 的較安全路徑 |

規格、baseline、credits 與 EBS-only 來自 AWS 的 [T3 product details](https://aws.amazon.com/ec2/instance-types/t3/) 及 [T4g product details](https://aws.amazon.com/ec2/instance-types/t4/)；AWS 定義一個 CPU credit 等於一個 vCPU 以 100% 使用一分鐘。表內 baseline 是「每個 vCPU」比例，因此兩個 vCPU 的 `micro` 合計基準相當於 20% 的單一 vCPU 容量，`small` 合計相當於 40%。

## CPU credits 與 Unlimited

T3/T4g 預設以 `unlimited` 啟動；只要 rolling 24 小時（或較短的 instance lifetime）平均 CPU 不高於 baseline，短暫尖峰已包含在 instance 小時費。長時間高於 baseline 時，可以持續 burst，但未由後續 earned credits 償還的 surplus credits 會另計費；`standard` 模式則在 accrued credits 用完後逐步降到 baseline。詳見 AWS [Unlimited mode](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode.html) 與 [credit concepts](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html)。

Linux 的 Unlimited surplus rate 是 T3 每 vCPU-hour $0.05、T4g 每 vCPU-hour $0.04；AWS 表示此費率不因區域或 instance size 改變，見 [EC2 On-Demand Pricing 的 T2/T3/T4g Unlimited 段落](https://aws.amazon.com/ec2/pricing/on-demand/)。

以現有 mean/p95 而言，長期平均遠低於四個候選的 baseline，約100% instant max 本身不等於會產生 Unlimited 額外費用；仍應看 `CPUCreditBalance`、`CPUSurplusCreditBalance` 與 `CPUSurplusCreditsCharged`。AWS 說明 surplus 收費條件及相應 CloudWatch metrics 於 [Unlimited mode concepts](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode-concepts.html)。目前資料不足以判定尖峰持續時間，也不應只用 instant max 排除 micro。

## x86 與 Arm 相容性

T3 使用 Intel x86_64；T4g 使用 64-bit Arm 的 AWS Graviton2。AMI 與 processor architecture 必須一致，AWS 明確指出跨 x86/Arm 不能只靠原機 resize，必須選擇相同架構的 AMI/instance type；見 [instance type change compatibility](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/resize-limitations.html)。因此 T3 → T4g 應視為以 arm64 AMI 重建、部署、資料還原與切換演練，而非單純修改 instance type。

PHP/WordPress 核心多半是可攜 workload，但實際是否可遷移取決於整條供應鏈。驗證清單至少包含：OS/AMI 的 arm64 版本、PHP 與所有 native extensions、ImageMagick/影像 codec、Web server、資料庫 client/server、WP-CLI、CloudWatch/安全/備份 agent、cron scripts、任何下載的預編譯 binary，以及 container image 是否有 `linux/arm64` manifest。AWS 的 Graviton 說明指出 interpreted/bytecode workloads 通常可少改動運行，但 C/C++ extension 或硬體特定指令需要 arm64 build；見 AWS [Graviton software considerations](https://docs.aws.amazon.com/whitepapers/latest/financial-services-grid-computing/graviton-instances.html)。Amazon Linux 2023 同時提供 x86-64 與 64-bit aarch64，且 Arm 版本支援 Graviton2 以後處理器，見 [AL2023 system requirements](https://docs.aws.amazon.com/linux/al2023/ug/system-requirements.html)。

## 新加坡 On-Demand Linux 價格

以下是 AWS Price List `AmazonEC2`、region `ap-southeast-1` 的 Linux/Shared/OnDemand、無額外預裝軟體單價，查核日為 2026-09-07；價格可能變更，未含 EBS、snapshot、data transfer、稅、Elastic IP/Public IPv4、Unlimited surplus credits 或其他服務。

| 類型 | USD / 小時 | 730 小時概算 / 月 |
| --- | ---: | ---: |
| `t3.micro` | $0.0132 | $9.64 |
| `t3.small` | $0.0264 | $19.27 |
| `t4g.micro` | $0.0106 | $7.74 |
| `t4g.small` | $0.0212 | $15.48 |

可重現的官方查價方式優先於複製靜態數字：使用 [AWS Price List Query API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html)，以 `location=Asia Pacific (Singapore)`、`instanceType`、`operatingSystem=Linux`、`tenancy=Shared`、`capacitystatus=Used`、`preInstalledSw=NA` 篩選，再讀 OnDemand price dimension 的 USD。CLI 的 Pricing endpoint 可指定 `us-east-1`，產品區域仍由 `location` filter 決定；也可在新加坡區域的 EC2 Console「Instance Types」顯示 On-Demand Linux pricing，AWS 操作方式見 [Find an EC2 instance type](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-discovery.html)。正式決策當日應重新查價。

## 排程關機成本試算

試算假設：每月 730 小時；週一至週五 08:00–22:00 開機，即每週 70 小時。按 `70 / 168` 的月時間比例換算，每月約運行 304.17 小時、停止 425.83 小時。基準是 `t3.small` 全月開機。金額為 USD，未含稅、EBS、snapshot、資料傳輸與 T3 Unlimited surplus credits。

此站已綁定一個 Public IPv4／Elastic IP，因此下表把該 IP 按 730 小時計入：`730 × $0.005 = $3.65/月`。AWS 的 [VPC Public IPv4 pricing](https://aws.amazon.com/vpc/pricing/) 說明 in-use 與 idle public IPv4 都是每小時 $0.005；因此保留固定 IP 時，EC2 關機不會省下這筆 IP 費。AWS 的 [EC2 stop/start 說明](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/how-ec2-instance-stop-start-works.html) 也明確指出：停止 instance 後不收 instance usage 與 data transfer 費，但 EBS volume 儲存與停機時仍關聯的 Elastic IP 會繼續收費。

| 方案 | EC2 運算費 / 月 | Public IPv4 / 月 | 小計（不含 EBS） | 相較 small 全開節省 | 節省比例* |
| --- | ---: | ---: | ---: | ---: | ---: |
| `t3.small` 全開 | $19.27 | $3.65 | $22.92 | — | — |
| `t3.small` 排程開機 | $8.03 | $3.65 | $11.68 | $11.24 | 49.0% |
| `t3.micro` 全開 | $9.64 | $3.65 | $13.29 | $9.64 | 42.0% |
| `t3.micro` 排程開機 | $4.02 | $3.65 | $7.67 | $15.26 | 66.6% |

\* 百分比以「EC2 運算費 + 一個保留整月的 Public IPv4」計算，未納入 EBS。若只比較 EC2 運算費，`small` 排程、`micro` 全開、`micro` 排程分別約省 58.3%、50.0%、79.2%。EBS 若規格不變，四個方案的 EBS 金額相同，所以不影響上表的「節省美元金額」，但納入完整帳單後會使節省百分比略低。

排程的實際月運行時數會隨當月工作日數變動；上述 304.17 小時是以全年平均週比例估算。每次由 stopped 轉為 running 至少計費一分鐘，詳見 AWS [EC2 instance lifecycle](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html)。若使用 Savings Plans、Reserved Instances、Free Tier 或其他折扣，不能直接套用此 On-Demand 試算。

## EBS 必須另算

四種 instance type 都是 EBS-only；instance 小時費不包含持久磁碟。AWS 說明 EBS volume 依 provisioned GB-month 計費，gp3 超過內含的 3,000 IOPS / 125 MB/s 時，額外 IOPS 與 throughput 也另計；snapshot 同樣另計，見 [Amazon EBS pricing](https://aws.amazon.com/ebs/pricing/)。比較月成本時應固定相同的 volume type、容量、IOPS、throughput、snapshot retention，避免把計算節省與儲存差異混在一起。

## 建議驗證順序

1. 先維持 2 GiB，補齊 CWAgent coverage，確認監控中斷原因；同時收集 OOM timestamp、被 kill process、PHP-FPM worker RSS/PSS、`pm.max_children`、swap、request concurrency 與 deploy/backup 時段。
2. 若要降成本且 Arm 相容性已完成，先用 `t4g.small` 以相同資料與設定重建 staging，做功能、外掛、排程、備份還原與尖峰負載測試；保留回到 `t3.small` 的路徑。
3. 只有在 OOM 根因已修正，且具代表性的 RAM p95/max 加上並行測試仍保有安全餘裕時，才 A/B 測試 1 GiB `micro`。不要由 約40% 平均 RAM 直接推論 1 GiB 足夠；平均值會隱藏短時 worker 疊加。
4. 試跑期間同看 CPU credits、surplus charge、RAM/swap、OOM、PHP-FPM queue/max-children、latency/error rate、EBS latency/queue。AWS 也提醒 instance 選型無法取代 workload load measurement，見 [Find an EC2 instance type](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-discovery.html)。

## 待訪談問題（不代答）

- staging 是否需要 24×7？可否排程 stop/start，且可接受的啟動時間為何？
- OOM 發生的確切時間、被 kill 的 process、當時是否 deploy、備份、掃描、匯入或流量尖峰？
- MySQL/MariaDB 是否與 PHP/WordPress 同機？尖峰 worker 數及單一 worker 記憶體是多少？
- 是否允許配置 swap？對偶發延遲與避免 OOM 的取捨標準是什麼？
- CWAgent coverage 約30% 是 agent、instance 停機、收集設定或報表窗口造成？補足多少天才算可決策？
- 有哪些 PHP native extensions、WordPress plugins、商用 agent、備份工具或自編 binary？是否都有 arm64 套件或 source build？
- 現行 AMI、部署 pipeline、container image 與復原程序是否支援 arm64？
- staging 要模擬 production 的 CPU architecture 嗎？若 production 是 x86，Arm staging 的差異是否可接受？
- 尖峰 CPU 約100% 持續多久、由何種工作造成？當時 credit balance 與 surplus metrics 為何？
- EBS volume type/容量/IOPS/throughput、snapshot retention、public IPv4 與 data transfer 的現況為何？
- 決策優先順序是最低月費、與 production 一致、最低遷移風險，還是 OOM resilience？可接受的回復時間與測試失敗條件為何？
