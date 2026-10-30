# 蒐集頻率與容量評估策略

## 已實作的蒐集方式

Host Assessment 結合 Linux SSH 快照、AWS CloudWatch 歷史與選用的 PHP-FPM／HTTP／crawler monitor。每日批次把來源資料彙整為 JSON／Markdown；單次快照不能取代歷史尖峰證據。

- 雲端指標：唯讀讀取 AWS 已保存的資料；實際來源粒度、保存範圍及 coverage 由報告揭露。
- PHP-FPM／HTTP：選用的主機端每分鐘 sampler；PSS 另依五分鐘時槽計算 coverage。
- crawler：選用的五分鐘資源與程序 sampler，不等同完整 crawler 降規決策器。
- 本機每日彙整：透過 SSH 與 AWS API 取回摘要，依 UTC 日期保存。主機監控與本機排程各自運作；停止本機排程不會停止主機 Agent／timer。

安裝項目、可能費用、主機負擔與停止方式見 [安裝與影響清單](installation-and-impact.md)。AWS API 查詢不在 EC2 上運算；SSH 查詢及主機端 sampler／Agent 仍會消耗 CPU、RAM、I/O 與空間，不是零負擔。

## 14 天與 30 天的用途

- **至少 14 天**：AWS WordPress 目標評估可在證據門檻全部符合時提出試降候選。這不是自動變更授權，也不是降規成功保證。
- **30 天或更長**：用於補足週期與趨勢的人工評估；天數變長不會自動把結果變成正式降規建議。
- 觀測期必須涵蓋預期的業務尖峰、備份與批次。未涵蓋月結、活動或季節負載時應延長或補充驗證。
- 部署前後的行為不同時，使用 [window-report](window-recompute.md) 重新彙整明確視窗，不把不同基準混為一談。

## 決策輸出與證據

`assess recommend` 提供風險與設定方向，不自動推薦升級 SKU。`assess target` 目前限 AWS WordPress，輸出 `insufficient_data`、`tune_php_fpm`、`maintain_current` 或 `target_trial_candidate`。既有預設 t3.large → t3.medium 流程使用 `maintain_t3_large`／`t3_medium_trial_candidate`；AWS 趨勢分析另有 operational_action／rightsizing_status，不應混為同一決策器。

目標評估會檢核 CPU／RAM、PHP、PSS、HTTP 與 EBS coverage、採樣缺口、資料日期、同主機必要事件，以及目標規格證據。未知 OOM、HTTP 來源不相容或不可讀的缺口紀錄不能補零。詳細門檻與人工判讀見 [分析 SOP](sop/rightsizing-analysis.md)。

工具保留實際可取得的平均值、分位數或尖峰；不是每個指標都有完整 p50／p95／p99。HTTP latency peak 是採樣批次分位數的最大值，不是整段期間的分位數；分鐘採樣不能保證捕捉所有瞬間尖峰。

## 如何使用建議

- 資源持續飽和且伴隨延遲、queue、5xx 或 OOM 時，先找出受限資源並排除可修復的程式與設定問題，再評估升規。
- 平均資源充足但偶發高記憶體請求時，優先補足尖峰證據與 PHP-FPM 預算，不只看閒時 RSS。
- 試降前核對目標 CPU、RAM、network、EBS 與相容性，準備監控、停機窗口及回滾。swap 可作緩衝，不能取代 RAM。

## 後續擴充

GCP Cloud Monitoring、跨雲價格、候選機型自動推薦、更完整的 workload 與事件診斷列於 [ROADMAP](../ROADMAP.md)。目前沒有因滿 30 天就自動輸出通用 `downsize_candidate` 的承諾。

## 自動化邊界

排程只執行盤點與分析，不自動套用 PHP 設定、重啟服務或更改 instance type。原始報告可能含主機識別資訊，保存在被忽略的 reports 目錄；另行制定保留與退場政策。資料不足時補查證據，不靠放寬門檻取得肯定結論。
