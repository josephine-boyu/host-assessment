# Host Assessment

唯讀主機盤點與資源配置評估工具。公開 repo 名稱為 `host-assessment`。

用來盤點各專案主機的硬體資源、服務設定與潛在瓶頸，協助判斷是否需要升降規格、調整 PHP-FPM 等服務參數，並留下可比較的健檢報告。

## 三層使用入口

| 層次 | 用途 | 入口 |
| --- | --- | --- |
| 工具 | 收集、規則分析、輸出報告 | 下方快速開始、[匿名範例](examples/)、[設定範本](config/projects.example.json) |
| 分析 SOP／Skill 素材 | 根據證據提出設定與規格建議 | [主機資源分析 SOP](docs/sop/rightsizing-analysis.md)；供人與 AI 使用，尚未封裝成可安裝 skill |
| 匿名案例 | 展示分析過程、限制與取捨 | [WordPress／PHP-FPM 試降案例](docs/case-studies/wordpress-rightsizing.md)，選讀，不是通用預設值 |

使用者可以先指定目標，請分析驗證可行性；也可以先盤點後取得建議。唯讀離線 `assess` 支援 `recommend` 與 `target` 兩種模式，詳見 [分析 SOP](docs/sop/rightsizing-analysis.md)。目標模式目前限 AWS WordPress，必須提供可核對的規格與業務事件；它不是最低價機型搜尋器。既有 daily 的預設目標仍為 `t3.medium`，缺少目標容量證據時會輸出資料不足。

長期項目見 [ROADMAP](ROADMAP.md)，發布品質要求見 [檢核表](docs/public-release-priorities.md)。

目前已支援 Linux／WordPress 唯讀快照、AWS CloudWatch 歷史、CloudWatch Agent guest metrics、PHP-FPM／HTTP 尖峰監控、多專案每日批次與 JSON／Markdown 分析報告。GCP collector、動態價格與選用 AI 分析仍在規劃中；核心判斷不依賴 AI。

目前的 `wp-server-audit.sh` 是唯讀的 WordPress/Linux 主機健檢腳本，會檢查 CPU、記憶體、swap、磁碟、負載、Web Server、PHP-FPM、OOM 紀錄、資料庫與 WP-Cron。它只提供風險提示，不會修改遠端設定，也不能只靠單次快照直接決定主機升降規格。

## 快速開始

執行前請先讀 [安裝項目、主機異動與影響清單](docs/installation-and-impact.md)。其中分開列出本機必要依賴、主機選用監控、費用與效能影響，以及更新／停止／回滾的限制。一般盤點不會自動替主機安裝 Agent 或服務。

需求：本機 Node.js 20 以上、Bash 與 OpenSSH，先執行 `npm ci` 安裝鎖定的依賴（Windows PowerShell 可用 `npm.cmd ci`）；目標 Linux 主機允許 SSH 登入。部分 kernel log 與設定需要目標帳號具備 `sudo -n` 權限，沒有權限時腳本會略過相關項目。

建議先在 `~/.ssh/config` 建立不含密鑰內容的連線別名：

```sshconfig
Host example-wp-staging
  HostName 203.0.113.10
  User ubuntu
  IdentityFile ~/.ssh/example-wp-staging.pem
  Port 22
```

手動執行：

```bash
./wp-server-audit.sh example-wp-staging
```

腳本也相容既有的參數形式：

```bash
./wp-server-audit.sh user@host /path/to/private-key.pem 22
```

私鑰路徑含空白時必須加引號。第一次連線會由 OpenSSH 記錄 host key；正式環境應另行核對 fingerprint。

若自動化或隔離執行環境的 `~/.ssh/config` 不是實際設定檔，可明確指定：

```bash
SSH_CONFIG='C:/Users/your-name/.ssh/config' ./wp-server-audit.sh example-wp-staging
```

## 管理多台主機

新的 projects 設定是後續多專案批次盤點的入口。先複製範本，密鑰仍只保存在 SSH/AWS 的使用者設定中：

```powershell
Copy-Item config/projects.example.json config/projects.local.json
node bin/ops-audit.mjs check
```

`check` 只讀取本機 projects JSON、SSH config 與 AWS named profile 的名稱，不會連線 SSH，也不會呼叫 AWS/GCP。它會檢查重複或不安全的專案 ID、workload type、SSH alias、AWS profile 及歷史天數。已啟用專案缺少必要設定會回傳 error；尚未啟用的 production 或 crawler 則回傳 warning，方便先完成設定再明確啟用。

目前支援的 `type` 是 `linux`、`wordpress`、`crawler`。`config/projects.local.json` 不會被 Git 追蹤，可版控格式以 `config/projects.example.json` 為準。

靜態檢查通過後，可批次執行所有 `enabled: true` 的 AWS 專案：

```powershell
node bin/ops-audit.mjs daily-all
```

`daily-all` 逐台執行，每個專案使用自己的 `cloud.profile` 與 `history_days`。單台失敗不會中止其他專案；結果寫入各主機原有的每日目錄，並在同日目錄新增 `batch-manifest.json`。目前非 AWS provider 會被記錄為失敗而不執行；crawler 暫時只使用共用 Linux collector，專屬 queue／重試檢查尚未加入。

預期在一般批次時間關機的專案可設定 `"include_in_daily_all": false`，讓無參數的 `daily-all` 略過；仍可用 `daily-all --project <id>` 在專屬排程中執行單台。`enabled: false` 則會同時禁止批次與單台執行。

WordPress/PHP 專案可在個別 project 加入預期 PHP 並行數，讓每日分析依主機 RAM、觀測到的最大 worker RSS 與 25% 安全係數計算 PHP-FPM 候選值：

```json
"workload": {
  "php_fpm": {
    "expected_concurrency": 4
  }
}
```

`expected_concurrency` 是尖峰時「同時執行中的 PHP 請求數」，不是登入人數。報告會列出非 PHP 記憶體保留量、worker 預算、記憶體可承載上限，以及 `pm`、`pm.max_children`、`pm.max_requests` 候選值；若容量不足或資料缺漏則明確提示。這些值只供驗證，不會自動修改 PHP-FPM。單獨執行 `analyze`、`report` 或 `daily` 時，也可用環境變數 `PHP_FPM_EXPECTED_CONCURRENCY` 提供相同資訊。

匿名 staging 案例的 t3.small 與 t3.micro 候選、歷史高點計算及驗證停止條件，記錄於 `docs/php-fpm-sizing.md`；機型選擇、排程關機與固定 Public IPv4 成本試算記錄於 `docs/staging-instance-sizing.md`。

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

`config/hosts.tsv`、`.env` 與 `reports/` 都已由 `.gitignore` 排除。`.env.example` 只示範非敏感的共用參數；密碼、token 與私鑰不應放進環境檔，即使該檔未被 Git 追蹤也一樣。

需要診斷 Linux/EBS 寫入來源時，可執行唯讀的 `scripts/disk-write-audit.sh <ssh-alias>`；它會盤點 journal/log、近期大檔與程序累積寫入量。使用方式與 crawler 首次判讀見 `docs/disk-write-audit.md`。

需要補足 PHP-FPM 尖峰時，可使用 `scripts/php-fpm-monitor.sh`。它會在明確 `--apply` 後建立 loopback-only status、每分鐘 hardened systemd oneshot 與 35 天數值歷史；不收 request URI 或 WordPress 資料，也不調整 PHP-FPM 容量設定。安全邊界、異動範圍、回滾及本機測試見 `docs/php-fpm-peak-monitor.md`。每日 collector 只取回最近 14 天摘要，不下載逐分鐘原始資料。

正式站 14 天降規決策還需要匿名 HTTP latency／5xx、PHP-FPM PSS/queue、EBS 飽和度及一次 PDF/email 業務尖峰。`scripts/http-metrics-monitor.sh` 提供分離的 `--check`、`--apply`、`--summary`、`--rollback` 介面；事件可用 `ops-audit mark-event` 在本機記錄。完整證據門檻、安全範圍與指令見 `docs/production-rightsizing-observation.md`。

HTTP 原始數值日誌由 Apache `rotatelogs` 保留兩個 10 MiB 循環檔（可能超出一個寫入 buffer），不再依賴每日 logrotate 才限制大小；每次 sampler 最多處理 1 MiB。輪替／Apache 重載，以及超量跳過的批次，都會留下資料缺口標記，該觀測視窗不會產生試降候選。這是偏保守、適合低流量站點的設計；高流量站點應使用具備完整流量處理能力的監控方案，不能直接調大限制後宣稱已驗證。安裝需至少 128 MiB 可用日誌空間，仍須納入其他應用日誌與磁碟用量。

EBS 每日證據必須完整符合觀測日期，指定視窗須符合每段起訖；業務事件的 `target` 必須與被分析主機相同。HTTP 來源版本、有效起點或缺口資訊無法驗證時回報資料不足；重新產生摘要不能替不相容的來源資料補齊證據。

PHP-FPM／HTTP monitor 的隔離安裝、更新與回滾測試，見 [systemd lifecycle 驗收](docs/monitor-lifecycle-validation.md)。此測試須明確執行，不會隨一般 `npm test` 啟動 Docker。

## 如何判斷升降規格

需要排除部署前的問題、重新分析指定期間時，使用 [指定區間重新彙整](docs/window-recompute.md) 的 `window-report`。它重新讀取來源資料並另存報告，支援明確時區與部分日，不會從舊彙總硬切出不存在的資料。

單次健檢適合找明顯風險，例如沒有 swap、近期 OOM、PHP-FPM 理論上限不合理或磁碟接近滿載。要做成本調整，仍需搭配至少 7～30 天的 CPU、記憶體、swap、磁碟 I/O、網路、PHP-FPM queue/active workers、Web latency 與資料庫指標，並保留尖峰餘裕。

建議流程是：先盤點 → 收集一段時間的趨勢 → 提出升降規格或設定建議 → 人工核准 → 另行變更 → 再觀察。盤點腳本與變更腳本應保持分離。

先依 [分析 SOP](docs/sop/rightsizing-analysis.md) 確認目標與證據，再參考 [匿名案例](docs/case-studies/wordpress-rightsizing.md)。案例示範慢 AJAX、PSS、pool 預演與試降規劃，沒有宣稱已完成硬體降規驗證。

報告資訊分成四個層次：

- **現況事實**：硬體、作業系統、服務狀態、PHP-FPM pool、資料庫與排程方式。
- **風險提示**：OOM、無 swap、磁碟偏滿、負載超過核心數、服務未自動啟動等。
- **設定建議**：可依量測結果建議 `pm.max_children`、slow log、swap、systemd restart policy 等；建議不會自動套用。
- **規格建議**：需要趨勢監控後才能可靠判斷升降級。AWS/GCP 比較方法與限制整理在 `docs/cloud-rightsizing.md`。

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

蒐集頻率、最低觀測期與升降規條件詳見 `docs/monitoring-strategy.md`。原則是雲端指標持續收集、工具每日彙整；正式降規通常至少需要 14 天，建議觀察 30 天並涵蓋業務尖峰。

AWS 歷史 collector 使用本機 Node.js 與 AWS SDK v3，不在 EC2 安裝 Node.js。設定好 `AWS_PROFILE` 後，可從既有 host JSON 讀取 instance ID 與 region：

```powershell
$env:AWS_PROFILE='your-readonly-profile'
node bin/ops-audit.mjs aws-history reports/example-wp-staging.json reports/history/aws-14d.json 14
```

輸出只包含已完成的 UTC 日，並標示 metric coverage、14 天初評或 30 天正式評估階段。預設只讀既有 `AWS/EC2` 指標；若同一 instance 已發布 `CWAgent` 的 RAM、swap 與 root disk 指標，collector 會自動發現並合併 daily average／p95／max 與 coverage。不開啟 EC2 Detailed Monitoring。執行環境與 Docker 決策詳見 `docs/runtime-strategy.md`。

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

Windows 排程使用未追蹤的 `config/daily-all.local.cmd`；格式以 `config/daily-all.example.cmd` 為準。Task Scheduler 每天本機時間 08:20 執行所有已啟用專案、錯過時間後補跑、最多執行 10 分鐘，並禁止同一工作重複併行。排程只在該 Windows 使用者登入時執行，因此不需把密碼存入 Task Scheduler。

請在不公開的營運清冊記錄監控排程、檢討日期、負擔與退場方式。短期觀測完成後依清冊停用或降頻，通用排程操作見下方文件。

目前排程名稱、驗證方式與限制詳見 `docs/windows-scheduler.md`。

## 選用 CloudWatch Agent

CloudWatch Agent 不是執行 Host Assessment 的必要條件。只有在需要 guest RAM、swap 與 filesystem 歷史，且既有監控沒有這些資料時才安裝；Agent 發布的是可能計費的 custom metrics，也會占用主機 CPU、RAM、磁碟與網路。

本 repo 的最小設定固定為 60 秒、metrics-only，只收 `mem_used_percent`、`swap_used_percent` 與 root `/` 的 `disk_used_percent`，不收 logs、traces 或 process。EC2 應使用 instance role 發布 metrics，不可把 IAM User Access Key 放進主機。

部署順序是先在 staging 觀察 24～48 小時，再決定 production；安裝、驗證、回滾及可重複腳本見 `docs/cloudwatch-agent-installation.md`，成本與負載限制見 `docs/cloudwatch-agent-impact.md`。移除 Agent 或 IAM role 都是主機／AWS 變更，不屬於每日唯讀盤點。

## 給 AI 協作者

AI 執行前必須遵循 `AGENTS.md`。預設只允許閱讀 repo、做本機語法檢查，以及在使用者指定主機後執行唯讀盤點；連線遠端、修改設定或建立 commit 都必須符合其中的操作邊界。

## 安全與公開分享

不要提交真實的 `reports/`、`config/*.local.*`、`config/hosts.tsv`、`.env`、私鑰或雲端憑證。公開報告前應移除 IP、hostname、帳號、instance／volume ID、客戶與訂單資訊。漏洞通報與支援範圍見 `SECURITY.md`；建立乾淨公開副本的檢查清單見 `docs/public-release.md`。

匿名輸入與輸出範例位於 `examples/`。它們只用於展示 schema 與報告格式，不代表任何真實主機。

## 授權

本專案以 MIT License 釋出，詳見 `LICENSE`。

## 後續方向

後續會依 `ROADMAP.md` 推進。AWS 唯讀 collector 已可將 instance 規格、CloudWatch 與 SSH 健檢結果合併；下一階段包含 GCP adapter、動態價格、公開版安全檢查與更完整的自動化。詳細機型與成本評估原則請參考 `docs/cloud-rightsizing.md`。
