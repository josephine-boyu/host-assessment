# 主機資源分析 SOP

這是供人與 AI 使用的通用分析流程，屬於公開內容第二層。目前是操作文件，尚未封裝為可安裝的 agent skill。工具入口見 [README](../../README.md)，選讀案例見 [WordPress 試降案例](../case-studies/wordpress-rightsizing.md)。

## 1. 確認分析入口

| 入口 | 使用者提供 | 分析交付 |
| --- | --- | --- |
| 已有目標 | 目標機型、RAM、預算或節費目標 | 評估目標可行性、必要條件、風險與替代方案 |
| 尚無目標 | 希望了解現況並取得建議 | 比較維持、服務調校、升規、降規、排程關機的適用性 |

兩種入口都先確認環境、工作負載、重要操作、尖峰／季節性、可接受延遲與錯誤率、停機窗口及回滾負責人。不要求使用者猜 PHP 並行量；可從量測取得，缺少時明列未知。已有目標也可以得到「目前不建議」的結論；沒有目標時不可預設一定要降規或指定 medium。

完成條件：記錄入口、目標（可為無）、限制與待確認事項。

## 2. 建立可比較的證據視窗

- 優先讀取本機報告；只有在使用者授權的主機與範圍內才執行 SSH 盤點。
- 記錄起訖時間、時區、部署時間、採樣粒度。效能修正前後分開比較，保留歷史異常；不能把問題樣本刪掉後宣稱改善。
- CloudWatch 的完整 UTC 日與 SSH rolling history 可能不同，須對齊或明列視窗差異。
- 14／30 天是觀測階段，不是自動批准降規的條件；須涵蓋代表性尖峰與重要業務操作。
- 檢查 CPU／credit、RAM／available、swap 活動、磁碟容量與 I/O、網路、OOM、HTTP 延遲／錯誤、服務並行量與業務事件。外部 DB 仍可能造成等待，低 CPU 不表示沒有瓶頸。
- 每項證據列出來源、視窗、coverage 與缺口。未知不是零；總 coverage 高仍可能漏掉尖峰。PSS 與每分鐘 status 的採樣頻率應分開計算。

完成條件：明確區分可用證據與不能支持結論的缺口。

## 3. 解讀指標

累計 counter 必須先依時間排序、去重，辨識 reset，再計算視窗內增量。服務啟動以來的 high-water mark 不等於本次視窗尖峰；每分鐘採樣也不能保證捕捉瞬間最大值。

「每分鐘 p95 的最大值」不是整段期間 p95。延遲異常要同時看頻率、持續時間、請求量、5xx 與業務影響。必要時另取得授權，就地聚合既有日誌；路徑中的訂單 ID 也需去識別化，不能只移除 query。相同秒數不等於同一請求，沒有 request ID 時只能標示時間關聯。不要為診斷重播會修改資料或寄信的請求。

完成條件：分開列出觀測事實、可能原因與尚未確認的根因。

## 4. 產生候選建議

已有目標時，比對目標的 RAM、CPU baseline／credits、I/O、網路與相容性；結論分為可試行、需先改善、資料不足或不建議。若估算成本，標示區域、價格日期、開機時數、磁碟、固定 IP 與其他不隨停機消失的成本。

尚無目標時，先判斷瓶頸與資源餘裕，再提出維持、調校、升降規或排程建議；節費只是其中一種結果。

PHP-FPM 建議使用 worker PSS、pool 用量、並行量與系統保留預算；RSS 可作補充但不能直接加總當整機用量。安全係數須標明是假設，`memory_limit` 不是程序 RSS 硬上限。Swap 是選用的尖峰保護，不應當成長期 RAM 容量。

每個候選都列出依據、設定／機型、預期效果、代價、不確定性、驗證與回滾方式。案例中的 worker 數與門檻不能直接套到其他主機。

## 5. 驗證與交付

在大主機限縮 PHP pool 只能驗證並行限制，不能完整模擬小主機 RAM、CPU credit 或 I/O 能力。實際變更前需另取得授權，備妥設定備份、停機窗口、監控、回滾責任與業務驗證。回滾恢復容量，不保證恢復中斷的業務操作。

OOM 或核心業務失敗應立即處理；單次 queue、counter 增量、swap 占用或慢請求則要搭配基線、持續時間及服務品質判斷。停止條件應事先約定。

報告固定包含：

1. 分析入口、目標與限制。
2. 證據視窗、coverage、部署與業務事件。
3. 現況、瓶頸與風險。
4. 候選方案、依據與取捨。
5. 驗證、停止條件與回滾。
6. 缺少資料與下一步。

## 目前程式支援邊界

兩種入口可使用唯讀離線命令：

```powershell
node bin/ops-audit.mjs assess reports/host.json reports/aws-history.json reports/events.jsonl config/assessment.example.json reports/advice.json reports/advice.md
```

`config/assessment.example.json` 是無目標的 `recommend`；`config/assessment-target.example.json` 是 `target` 範本，請複製到未追蹤的 local 設定後填入規格。範本的 null 不是預設能力；未填齊會回報資料不足。`target` 目前限 AWS WordPress，需指定 `required_event`、RAM、vCPU、CPU baseline 百分比、network baseline MiB/s、instance EBS baseline IOPS／MiB/s、相容性確認、資料來源與核對時間。規格須來自官方查詢或已審查資料，工具不替使用者認證來源。

可選 `observation_start`／`observation_end` 是證據視窗的檢核條件，不會裁切既有摘要。不符合時阻擋目標結論。比較部署後區間時，先用 [window-report](../window-recompute.md) 從保留的 PHP／HTTP 歷史與 CloudWatch 重新彙整，再使用 `assess`；資料不足或時間粒度不符時明確停止結論。

PHP／HTTP 摘要使用完整 UTC 日、唯一分鐘時槽與獨立五分鐘 PSS 時槽。只有來源版本相容、有效起點可驗證且原始歷史足夠時，才能重新彙整所需證據；重新產生摘要不能補回不存在的觀測資料，也不能讓不相容的來源通過檢核。coverage 仍需至少 90%，超過 10 分鐘無採樣也會要求補查。timer 漂移造成的空時槽與真正停機不能單靠此數字區分。HTTP 慢樣本固定為至少 20 requests、p95 ≥ 3 秒；連續 5 個分鐘時槽視為持續惡化，這些是初版啟發式門檻，尚未開放任意品質參數。

`recommend` 提供現有規則的風險與調校方向，不承諾自動找到最低成本。`target` 增加容量比較，但仍不能代表 crawler、GCP 或所有硬體架構。14 天試降候選與 30 天 AWS 趨勢評估是不同層次，兩者均需人工審核。

規則輸出與人工分析若有差異，必須解釋證據及限制，不能悄悄把規則結果改成「可降規」。後續修正見 [公開前優先項目](../public-release-priorities.md)。

每日與指定視窗的 CloudWatch CPU／RAM coverage 都會額外核對來源時槽；network／EBS peak 也按唯一有效時槽計算，不以「每天有一筆」當作完整。時槽粒度依監控模式及 CloudWatch 保存期為 60／300／3600 秒；它不能證明聚合時槽內沒有更短的資料缺口。舊 AWS JSON 不會自動補齊此證據，須重新收集。HTTP 同分鐘多筆合格慢樣本仍只算一個慢時槽，空缺分鐘會中斷連續性。

EBS daily 的日期與部分日起訖也必須與觀測窗一致，每個 attached volume 都要有對應證據；事件標記須符合 `hostAudit.target`。HTTP `collection_gap_count` 必須為零，缺欄位或紀錄不可讀都不能視為零。全新安裝須依 [安裝與影響清單](../installation-and-impact.md) 完成來源設定與驗證，再開始累積有效觀測。盤點與重新彙整皆不會自動安裝或更改主機上的監控設定。

EBS exceeded-check 有資料也不能取代尖峰時槽 coverage；用來比較目標容量的分鐘指標仍須完整。EC2 status check 有已知失敗時維持現況並先調查，缺少健康證據則為資料不足。OOM 僅在 journalctl 實際成功後才標示可查詢，失敗或缺值不能補成零。HTTP 資料須具備相容的來源版本、有效起點與可讀的缺口紀錄；缺少證據時回報資料不足。全新安裝與影響見 [安裝與影響清單](../installation-and-impact.md)。
