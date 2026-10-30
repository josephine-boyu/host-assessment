# 正式站 14 天降規決策觀測

目標是讓目前為 `t3.large` 的正式站，在資料完整時輸出三種人工審核結論之一：維持 `t3.large`、先調整 PHP-FPM，或將 `t3.medium` 列為受控試降候選。其他來源機型會回報資料／適用範圍不足，不會誤套這組門檻。工具不會自行修改 EC2 或 PHP-FPM。

## 需要補齊的證據

- CloudWatch：CPU 與 CWAgent RAM 至少 14 個完整 UTC 日，coverage 至少 90%。
- PHP-FPM：每分鐘 active/queue、`max children reached`、worker PSS，coverage 至少 90%。
- HTTP：每分鐘 request count、status 分布與 latency percentile，coverage 至少 90%。只記錄 epoch、status、duration，不記錄 IP、URL、query、cookie、user-agent 或 request body。
- EBS：attached volume inventory、queue、latency、IOPS/throughput exceeded 與 stalled check。
- 業務尖峰：觀測窗內至少完整執行一次 PDF 產生與寄信流程，使用本機事件標記留下開始／完成時間，不記錄訂單或使用者資料。

AWS 唯讀 IAM policy 需包含 `ec2:DescribeVolumes`，才能取得 EBS volume type、容量與 provisioned IOPS/throughput；既有 `cloudwatch:GetMetricData` 用來讀 EBS 指標。

## 本機事件標記

在進行可重現的 PDF／寄信驗證前後，於 Host Assessment 本機執行：

```powershell
node bin/ops-audit.mjs mark-event example-wp-production pdf-email-test start
# 由操作者在網站完成既有測試流程
node bin/ops-audit.mjs mark-event example-wp-production pdf-email-test end
```

資料寫入被 Git 忽略的 `reports/events/`。不要在 event 名稱放訂單編號、email、客戶名稱或其他個資。

## HTTP monitor 部署介面

全新安裝順序與資源／費用影響，先讀 [集中清單](installation-and-impact.md)。HTTP monitor 排除 PHP status VirtualHost 的內部探測；有效觀測自成功安裝開始，來源版本或有效起點無法驗證時回報資料不足。

先做唯讀 preflight：

```bash
scripts/http-metrics-monitor.sh --check example-wp-production
```

只有收到明確授權後才可執行 `--apply`。它會以 Apache `GlobalLog` 新增一條涵蓋所有 VirtualHost 的匿名 piped log、`rotatelogs` 循環寫入及輪替缺口標記程式、hardened systemd oneshot/timer，並每 60 秒寫入數值摘要；不修改 WordPress、PHP-FPM pool 或既有網站 access log。舊的專用 logrotate 規則改為註解占位，避免兩套機制管理同一檔案。安裝會先備份同名設定並執行 Apache configtest，失敗時自動還原。既有安裝升級使用明確的 `--update`，不以 `--apply` 覆蓋。

```bash
scripts/http-metrics-monitor.sh --apply example-wp-production
scripts/http-metrics-monitor.sh --update example-wp-staging
scripts/http-metrics-monitor.sh --summary example-wp-production 14
scripts/http-metrics-monitor.sh --rollback example-wp-production /var/backups/ops-toolkit/http-metrics/YYYYMMDDTHHMMSSZ
```

Apache 每個 request 多寫一行三個數字，另有常駐的 `rotatelogs` 程序；每分鐘執行一次受 64 MiB、10 秒限制的短暫彙整程序。兩個 10 MiB 循環檔的大小可超出一個寫入 buffer，current `.metrics` 是 hard link，不另占一份內容。每批最多處理 1 MiB，未完成的尾端行留待下次；超量時跳過並記錄缺口。數值歷史與缺口標記保留 35 天。這是低流量站點的有界採樣方式，仍應在 staging 量測 CPU／RSS 與網站延遲後逐台部署；未驗證高流量生產負載。

安裝 preflight 要求 `/usr/sbin/rotatelogs` 及至少 128 MiB 可用日誌空間。容量限制只涵蓋本 monitor 的循環檔，不會清除其他既有日誌或限制網站其他日誌。輪替或 Apache 重載會保守標記可能漏收，視窗內 `collection_gap_count` 大於零或未知時阻擋試降。應選擇沒有缺口、具代表性流量的觀測窗；頻繁輪替時需更完整的監控方案，不能把缺口當成零。

EBS 日期與指定視窗段落必須完整一致；PDF/email 事件必須屬於相同的 SSH target，不能以另一台測試機的事件補正式機證據。

## 判斷邏輯

- 任一必要 coverage、PSS、EBS 或 PDF/email 事件缺失：`insufficient_data`。
- 有 OOM、PHP queue／max children reached，或投影到 4 GiB 後 RAM 使用達 80%：`tune_php_fpm`。
- HTTP 5xx／p95 latency、EBS 或 CPU p95 有壓力：`maintain_t3_large`。
- 所有門檻通過且保有至少 20% 記憶體餘裕：`t3_medium_trial_candidate`。

候選不等於可直接降規；仍須安排回滾窗口、變更後驗證 PDF/email 與主要登入流程，並繼續觀察至少數日。
