# 命令與多主機操作指南

先完成 [首頁快速開始](../README.md) 與 [安裝影響確認](installation-and-impact.md)。以下命令均從 repo 根目錄執行；npm ci 不會將本專案 CLI 加入一般終端機的 PATH。

## 管理多台主機

projects 設定是多專案批次盤點的入口。先複製範本，密鑰仍只保存在 SSH/AWS 的使用者設定中：

```powershell
Copy-Item config/projects.example.json config/projects.local.json
node bin/ops-audit.mjs check
```

`check` 會讀取本機 projects JSON、SSH config，以及 AWS credentials/config 檔案內容，在記憶體解析 SSH alias 與 profile 名稱；不會連線 SSH、呼叫雲端 API，或將金鑰內容寫入檢查結果。檢查通過不代表實際連線與 IAM 權限已驗證。

- 設定格式錯誤（例如重複 ID、缺少 ssh.target／cloud.profile、型別或天數錯誤）一律是 error，即使專案未啟用，也會阻擋批次前置檢查。
- 設定格式正確，但本機找不到該專案的 SSH alias／AWS profile：已啟用專案為 error，未啟用專案為 warning。
- 整份 SSH config 不存在仍是全域 error，不因專案停用而降級。

目前支援的 `type` 是 `linux`、`wordpress`、`crawler`。`config/projects.local.json` 不會被 Git 追蹤，可版控格式以 `config/projects.example.json` 為準。

靜態檢查通過後，可批次執行所有 `enabled: true` 的 AWS 專案：

```powershell
node bin/ops-audit.mjs daily-all
```

`daily-all` 逐台執行，每個專案使用自己的 `cloud.profile` 與 `history_days`。單台失敗不會中止其他專案；結果寫入各主機原有的每日目錄，並在同日目錄新增 `batch-manifest.json`。目前非 AWS provider 會被記錄為失敗而不執行；crawler 暫時只使用共用 Linux collector，專屬 queue／重試檢查尚未加入。

預期在一般批次時間關機的專案可設定 `"include_in_daily_all": false`，讓無參數的 `daily-all` 略過；仍可用 `daily-all --project <id>` 在專屬排程中執行單台。`enabled: false` 則會同時禁止批次與單台執行。

WordPress/PHP 專案可在個別 project 加入預期 PHP 並行數，讓每日分析依主機 RAM、依序優先採用的歷史單 worker PSS 最大值、歷史單 worker RSS 最大值或快照 RSS 最大值，並套用 1.25 安全係數計算 PHP-FPM 候選值：

```json
"workload": {
  "php_fpm": {
    "expected_concurrency": 4
  }
}
```

`expected_concurrency` 是尖峰時「同時執行中的 PHP 請求數」，不是登入人數。報告會列出非 PHP 記憶體保留量、worker 預算、記憶體可承載上限，以及 `pm`、`pm.max_children`、`pm.max_requests` 候選值；若容量不足或資料缺漏則明確提示。這些值只供驗證，不會自動修改 PHP-FPM。單獨執行 `analyze`、`report` 或 `daily` 時，也可用環境變數 `PHP_FPM_EXPECTED_CONCURRENCY` 提供相同資訊。

匿名 staging 案例的 t3.small 與 t3.micro 候選、歷史高點計算及驗證停止條件，記錄於 [php-fpm-sizing.md](php-fpm-sizing.md)；機型選擇、排程關機與固定 Public IPv4 成本試算記錄於 [staging-instance-sizing.md](staging-instance-sizing.md)。

Windows 建議複製 `config/daily-all.example.cmd` 為不追蹤的 `config/daily-all.local.cmd`，由 wrapper 設定本機路徑並在執行前確認必要檔案存在：

```powershell
# 執行全部 enabled: true 的專案
config\daily-all.local.cmd

# 只執行指定且 enabled: true 的專案
config\daily-all.local.cmd example-wp-staging
```

指定單台不會繞過 `enabled`：若該專案是 `enabled: false`，命令會停止且不連線。直接執行 Node CLI 但未設定 `SSH_COMMAND` 時，Windows 會提示目前將使用系統 ssh；SSH config 與 AWS 設定檔／profile 不存在則會在 preflight 停止。

1. 複製 `config/hosts.example.tsv` 為 `config/hosts.tsv`。
2. 每台主機填一列：專案、環境、SSH alias、盤點腳本。
3. 私鑰只放在 `~/.ssh` 或密鑰管理服務，不寫入 TSV、`.env` 或 Git。
4. 健檢輸出存入 `reports/`，分享前先移除不必要的主機識別資訊。

批次執行全部已啟用的資料列：

```bash
./audit-all.sh
```

只驗證清單格式與目標、不連線主機：

```bash
./audit-all.sh --check
```

每次執行會建立 `reports/<時間戳>/`，內含各主機的 Markdown 與 `summary.tsv`；摘要會列出執行狀態與 Critical/Warning 風險數。單台失敗不會中斷其餘主機；全部跑完後只要有失敗，runner 會回傳非零狀態，方便未來接排程或 CI。以 `#` 開頭的主機列不會執行，可先保留尚未設定完成的第二台。

`config/hosts.tsv`、`.env` 與 `reports/` 都已由 `.gitignore` 排除。`.env.example` 只示範非敏感的共用參數，不會自動載入；密碼、token 與私鑰不應放進環境檔，即使該檔未被 Git 追蹤也一樣。

需要診斷 Linux/EBS 寫入來源時，可執行唯讀的 `scripts/disk-write-audit.sh <ssh-alias>`；它會盤點 journal/log、近期大檔與程序累積寫入量。使用方式與 crawler 首次判讀見 [disk-write-audit.md](disk-write-audit.md)。

需要補足 PHP-FPM 尖峰時，可使用 `scripts/php-fpm-monitor.sh`。它會在明確 `--apply` 後建立 loopback-only status、每分鐘 hardened systemd oneshot 與 35 天數值歷史；不收 request URI 或 WordPress 資料，也不調整 PHP-FPM 容量設定。安全邊界、異動範圍、回滾及本機測試見 [php-fpm-peak-monitor.md](php-fpm-peak-monitor.md)。SSH monitor 摘要預設 14 天；`daily` 會傳入指定天數，SSH collector 接受 1～35 天，不下載逐分鐘原始資料。這是 SSH monitor 摘要的限制，不代表所有功能的歷史範圍。

正式站 14 天降規決策還需要匿名 HTTP latency／5xx、PHP-FPM PSS/queue、EBS 飽和度及一次 PDF/email 業務尖峰。`scripts/http-metrics-monitor.sh` 提供分離的 `--check`、`--apply`、`--summary`、`--rollback` 介面；事件可用 `node bin/ops-audit.mjs mark-event` 在本機記錄。完整證據門檻、安全範圍與指令見 [production-rightsizing-observation.md](production-rightsizing-observation.md)。

HTTP 原始數值日誌由 Apache `rotatelogs` 保留兩個 10 MiB 循環檔（可能超出一個寫入 buffer），不再依賴每日 logrotate 才限制大小；每次 sampler 最多處理 1 MiB。輪替／Apache 重載，以及超量跳過的批次，都會留下資料缺口標記，該觀測視窗不會產生試降候選。這是偏保守、適合低流量站點的設計；高流量站點應使用具備完整流量處理能力的監控方案，不能直接調大限制後宣稱已驗證。安裝需至少 128 MiB 可用日誌空間，仍須納入其他應用日誌與磁碟用量。

EBS 每日證據必須完整符合觀測日期，指定視窗須符合每段起訖；業務事件的 `target` 必須與被分析主機相同。HTTP 來源版本、有效起點或缺口資訊無法驗證時回報資料不足；重新產生摘要不能替不相容的來源資料補齊證據。

PHP-FPM／HTTP monitor 的隔離安裝、更新與回滾測試，見 [systemd lifecycle 驗收](monitor-lifecycle-validation.md)。此測試須明確執行，不會隨一般 `npm test` 啟動 Docker。

## 如何判斷升降規格

需要排除部署前的問題、重新分析指定期間時，使用 [指定區間重新彙整](window-recompute.md) 的 `window-report`。它重新讀取來源資料並另存報告，支援明確時區與部分日，不會從舊彙總硬切出不存在的資料。

單次健檢適合找明顯風險，例如沒有 swap、近期 OOM、PHP-FPM 理論上限不合理或磁碟接近滿載。要做成本調整，仍需搭配至少 14 天具代表性的 CPU、記憶體、swap、磁碟 I/O、網路、PHP-FPM queue/active workers、Web latency 與資料庫指標，並保留尖峰餘裕。

建議流程是：先盤點 → 收集一段時間的趨勢 → 提出升降規格或設定建議 → 人工核准 → 另行變更 → 再觀察。盤點腳本與變更腳本應保持分離。

先依 [分析 SOP](sop/rightsizing-analysis.md) 確認目標與證據，再參考 [匿名案例](case-studies/wordpress-rightsizing.md)。案例示範慢 AJAX、PSS、pool 預演與試降規劃，沒有宣稱已完成硬體降規驗證。

報告資訊分成四個層次：

- **現況事實**：硬體、作業系統、服務狀態、PHP-FPM pool、資料庫與排程方式。
- **風險提示**：OOM、無 swap、磁碟偏滿、負載超過核心數、服務未自動啟動等。
- **設定建議**：可依量測結果建議 `pm.max_children`、slow log、swap、systemd restart policy 等；建議不會自動套用。
- **規格建議**：需要趨勢監控後才能可靠判斷升降級。AWS/GCP 比較方法與限制整理在 [cloud-rightsizing.md](cloud-rightsizing.md)。

## JSON 收集與分析報告

流程將資料收集、規則分析與呈現分開。需要本機 Node.js 20 以上，並以 `npm ci` 安裝包含 AWS SDK v3 的依賴。

從主機收集唯讀快照：

```bash
SSH_CONFIG='C:/Users/your-name/.ssh/config' \
  node bin/ops-audit.mjs collect example-wp-staging reports/example-wp-staging.json
```

若 Windows OpenSSH 因既有私鑰 ACL 拒絕連線，而該連線已由 Git Bash 驗證，可明確指定 Git for Windows 的 SSH adapter：

```powershell
$env:SSH_COMMAND='C:/Program Files/Git/usr/bin/ssh.exe'
```

套用規則並產生 JSON 與 Markdown 分析報告：

```bash
node bin/ops-audit.mjs analyze \
  reports/example-wp-staging.json \
  reports/example-wp-staging-analysis.json \
  reports/example-wp-staging-analysis.md
```

規則只根據 JSON 中存在的證據產生結果；單次快照固定提示資料不足以支持降規。AWS 歷史監控已接入；GCP 與選用 AI 深度分析尚未實作。

蒐集頻率、最低觀測期與升降規條件詳見 [monitoring-strategy.md](monitoring-strategy.md)。原則是雲端指標持續收集、工具每日彙整；目前試降判斷至少需要 14 天有效證據，建議觀察 30 天並涵蓋業務尖峰。

AWS 歷史 collector 使用本機 Node.js 與 AWS SDK v3，不在 EC2 安裝 Node.js。設定好 `AWS_PROFILE` 後，可從既有 host JSON 讀取 instance ID 與 region：

```powershell
$env:AWS_PROFILE='your-readonly-profile'
node bin/ops-audit.mjs aws-history reports/example-wp-staging.json reports/history/aws-14d.json 14
```

輸出只包含已完成的 UTC 日，並標示 metric coverage、14 天初評或 30 天正式評估階段。讀取既有 `AWS/EC2` 指標，並對發現的磁碟建立 `AWS/EBS` 查詢；若同一 instance 已發布 `CWAgent` 的 RAM、swap 與 root disk 指標，collector 會自動發現並合併 daily average／p95／max 與 coverage。不開啟 EC2 Detailed Monitoring。執行環境與 Docker 決策詳見 [runtime-strategy.md](runtime-strategy.md)。

將 AWS history 與 SSH snapshot 合併成規則分析與 Markdown：

```powershell
node bin/ops-audit.mjs aws-analyze `
  reports/history/aws-14d.json `
  reports/example-wp-staging.json `
  reports/history/aws-14d-analysis.json `
  reports/history/aws-14d-analysis.md
```

分析會分開輸出 `operational_action` 與 `rightsizing_status`；CPU 有餘裕不等於整機可降規，近期 OOM、缺少 guest RAM 歷史或 coverage 不足都會阻擋降規。

每日手動執行可用單一命令：

```powershell
$env:AWS_PROFILE='ops-toolkit-readonly'
$env:AWS_SHARED_CREDENTIALS_FILE='C:/Users/your-name/.aws/credentials'
$env:AWS_CONFIG_FILE='C:/Users/your-name/.aws/config'
$env:SSH_CONFIG='C:/Users/your-name/.ssh/config'
$env:SSH_COMMAND='C:/Program Files/Git/usr/bin/ssh.exe'
node bin/ops-audit.mjs daily example-wp-staging 14
```

輸出位於 `reports/history/<UTC日期>/<target>/`，包含 host JSON/Markdown、AWS history JSON、AWS 分析 JSON/Markdown 與 `manifest.json`。不同日期不會互相覆寫；同一天重跑會更新當日結果。正式建立排程前，先手動完成一次端到端驗證。

Windows 排程需自行建立，可使用未追蹤的 `config/daily-all.local.cmd`；格式以 `config/daily-all.example.cmd` 為準。排程文件範例設定為每天本機時間 08:20 執行所有已啟用專案、錯過時間後補跑、最多執行 10 分鐘，並禁止同一工作重複併行。排程只在該 Windows 使用者登入時執行，因此不需把密碼存入 Task Scheduler。

請在不公開的營運清冊記錄監控排程、檢討日期、負擔與退場方式。短期觀測完成後依清冊停用或降頻，通用排程操作見下方文件。

建立方式、驗證與限制詳見 [windows-scheduler.md](windows-scheduler.md)。

## 選用 CloudWatch Agent

CloudWatch Agent 不是執行 Host Assessment 的必要條件。只有在需要 guest RAM、swap 與 filesystem 歷史，且既有監控沒有這些資料時才安裝；Agent 發布的是可能計費的 custom metrics，也會占用主機 CPU、RAM、磁碟與網路。

本 repo 的最小設定固定為 60 秒、metrics-only，只收 `mem_used_percent`、`swap_used_percent` 與 root `/` 的 `disk_used_percent`，不收 logs、traces 或 process。EC2 應使用 instance role 發布 metrics，不可把 IAM User Access Key 放進主機。

部署順序是先在 staging 觀察 24～48 小時，再決定 production；安裝、驗證、回滾及可重複腳本見 [cloudwatch-agent-installation.md](cloudwatch-agent-installation.md)，成本與負載限制見 [cloudwatch-agent-impact.md](cloudwatch-agent-impact.md)。移除 Agent 或 IAM role 都是主機／AWS 變更，不屬於每日唯讀盤點。
