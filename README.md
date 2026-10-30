# Host Assessment

唯讀主機盤點與資源配置評估工具，輸出 JSON／Markdown 報告，協助找出資源壓力、PHP-FPM 設定風險，以及是否具備試降規格的證據。

報告包含現況數據、風險提示、設定候選值與資料不足原因。建議供人工審核，不會自動調整主機或挑選最低價機型；單次快照不能作為降規依據。核心分析使用規則，不依賴 AI。

## 適用環境與驗證範圍

| 功能 | 適用條件 | 驗證範圍與限制 |
| --- | --- | --- |
| SSH 唯讀快照 | Linux、Bash、SSH；部分項目需 sudo -n | 有 Linux／WordPress 使用經驗與 collector 測試；不同發行版、權限及服務可能缺資料，並非跨發行版相容保證 |
| AWS 歷史與規格分析 | EC2／CloudWatch 唯讀權限；RAM 歷史需已有相容 CWAgent 指標 | AWS adapter 與分析規則有測試；daily／daily-all 目前限 AWS。GCP collector 尚未實作 |
| 目標規格評估 | AWS WordPress、完整趨勢與目標容量、業務尖峰事件 | assess 支援 recommend／target；資料不足不給試降候選，尚無通用升級 SKU 推薦 |
| PHP-FPM／HTTP 監控安裝（選用） | systemd、Apache httpd、php-fpm，符合安裝器固定服務與設定路徑 | 已有隔離 Amazon Linux／systemd 安裝及回滾驗收；不能直接套用 Nginx、Debian apache2 或任意 PHP 版本／pool 配置。高流量尚未全面驗收 |
| CloudWatch Agent／crawler 監控（選用） | 各安裝器要求的套件、路徑及權限 | 不在上述 PHP／HTTP lifecycle 完整驗收範圍；逐台先做 preflight |

安裝條件及異動詳見 [安裝項目與影響](docs/installation-and-impact.md)，已驗證流程見 [monitor lifecycle 驗收](docs/monitor-lifecycle-validation.md)。

## 先看一份報告

本機需要 Node.js 20+ 與 npm。下載 repo 並進入專案根目錄後執行：

```sh
npm ci
node bin/ops-audit.mjs analyze examples/host-snapshot.json reports/demo.json reports/demo.md
```

Windows PowerShell 若阻擋 npm.ps1，第一行改用 `npm.cmd ci`。

安裝依賴可能需要網路；安裝完成後，上述範例分析可離線執行，不需 SSH／AWS 憑證，也不連線主機。開啟產生的 `reports/demo.md`，或直接閱讀 [匿名範例報告](examples/host-analysis.md) 與 [範例輸入](examples/host-snapshot.json)。範例只展示格式與規則判讀，不能作為真實主機降規依據。

## 盤點真實主機前的準備

1. 本機準備 Bash 與 OpenSSH（Windows 可使用 Git for Windows），在自己的 SSH config 建立 Host alias，核對主機 fingerprint。私鑰留在 SSH／憑證管理服務。
2. AWS 歷史分析另外需要唯讀 AWS profile；權限與安裝影響先閱讀 [操作影響清單](docs/installation-and-impact.md)。一般 SSH 快照不需要 AWS 憑證。
3. 需要多專案管理時，複製 `config/projects.example.json` 為 `config/projects.local.json`，調整目標及啟用狀態後執行：

```sh
node bin/ops-audit.mjs check
```

`check` 會讀入 projects JSON、SSH config 與 AWS credentials/config 的文字，解析 alias／profile 名稱；不連線主機或雲端，也不將金鑰內容寫入檢查結果。格式錯誤一律是 error；停用專案缺少本機 alias／profile 才降為 warning。整份 SSH config 不存在仍是 error。通過靜態檢查不代表連線或 IAM 權限有效。

確認目標並取得授權後，執行一次唯讀快照及報告（將別名替換為自己的）：

```sh
node bin/ops-audit.mjs report example-wp-staging reports/example-wp-staging
```

環境變數可透過 PowerShell 或 Bash 設定：

```powershell
$env:SSH_CONNECT_TIMEOUT='8'
```

```bash
export SSH_CONNECT_TIMEOUT=8
```

**程式不會自動載入 .env。** [.env.example](.env.example) 是參數參考，僅複製或填寫不會生效；也可使用 [Windows wrapper 範本](config/daily-all.example.cmd) 設定執行環境。`npm ci` 不會把 `ops-audit` 加入一般終端機的 PATH，本文件使用可直接執行的 `node bin/ops-audit.mjs`。

## 哪些操作會修改主機

| 操作 | 影響 |
| --- | --- |
| analyze／assess、check | 本機讀取與分析；報告寫入本機，check 不連線 |
| collect／report／daily／daily-all／window-report | 讀取遠端或雲端資料、寫入本機報告；不安裝服務或調整主機。查詢仍消耗 CPU／I/O，SSH／sudo 可能留下系統稽核日誌 |
| monitor 的 --check | 會透過 SSH 唯讀查核主機，不等同本機 check |
| 選用安裝／調校／回滾腳本 | 明確執行後才修改套件、服務、設定或 timer，部分操作會重載 Apache／PHP-FPM；須先審核影響、備份與回滾方式 |

一般盤點不會自動安裝監控。CloudWatch Agent custom metrics 與雲端 API 可能計費；唯讀也不等於零負擔。完整項目與停止方式見 [安裝與影響清單](docs/installation-and-impact.md)。

## 後續使用入口

| 目的 | 文件 |
| --- | --- |
| 多主機、批次、AWS 歷史與命令範例 | [命令指南](docs/command-guide.md) |
| 評估規格、設定候選值與證據門檻 | [分析 SOP／Skill 素材](docs/sop/rightsizing-analysis.md)（尚非可安裝 skill）、[匿名案例](docs/case-studies/wordpress-rightsizing.md) |
| 收集頻率與觀測期 | [監控策略](docs/monitoring-strategy.md) |
| 選用 PHP／HTTP 尖峰監控 | [PHP monitor](docs/php-fpm-peak-monitor.md)、[HTTP monitor](docs/production-rightsizing-observation.md) |
| 選用 guest RAM 歷史 | [CloudWatch Agent](docs/cloudwatch-agent-installation.md) |
| 本機每日排程 | [Windows 排程](docs/windows-scheduler.md)（需自行建立） |
| 指定日期分析與資料品質 | [區間重算](docs/window-recompute.md)、[資料相容性](docs/installation-and-impact.md#全新安裝與資料相容性) |

規格評估需累積具代表性的有效證據，涵蓋尖峰；目前 14 天試降判斷有 coverage 與業務事件等門檻，天數足夠不代表一定可降規。詳細依分析 SOP，不以範例候選值代替量測。

## 安全與協作

AI 協作者先讀 [AGENTS.md](AGENTS.md)。真實 reports、本機設定、.env、私鑰及憑證不提交；分享報告前去除 IP、hostname、帳號、雲端資源 ID 與業務資訊。

漏洞通報見 [SECURITY.md](SECURITY.md)，後續功能見 [ROADMAP](ROADMAP.md)，維護者發布流程見 [發布指南](docs/public-release.md)。本專案採 [MIT License](LICENSE)。
