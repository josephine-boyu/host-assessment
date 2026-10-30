# 安裝項目、主機異動與影響清單

一般 `collect`／`report`／`daily`／`daily-all`／`window-report` 不會替目標主機安裝套件或常駐服務，也不會自動調整 PHP、swap 或 EC2 規格。`ops-audit check` 只檢查本機設定；各 monitor 腳本的 `--check` 則會透過 SSH 唯讀查核目標主機。安裝與變更腳本須另行明確執行；先對 staging 做 preflight，再逐台授權。

## 管理者電腦

| 項目 | 何時需要／怎麼取得 | 額外影響與停止方式 |
| --- | --- | --- |
| Node.js 20+、npm | 工具必要依賴，由操作者自行安裝 | Node 在本機執行，不安裝到 EC2；命令執行時消耗本機 CPU／RAM |
| AWS SDK v3 與間接依賴 | `npm ci` 依 package-lock.json 下載到 repo 的 node_modules | 需要下載空間與網路；不做全域安裝。npm 可執行依賴提供的安裝腳本（若有），更新 lock 時應審閱依賴變更。AWS CLI 不是必要依賴，CLI／SSO 登入工具若另用，須自行安裝設定 |
| Bash、OpenSSH | Windows 可用 Git for Windows；Linux 使用已有套件 | SSH 使用個人的 config／私鑰；不複製到 repo。第一次連線需核對 host key；不要停用驗證 |
| 報告與本機排程 | 報告寫入 reports；Windows 排程依指南另建，並非 npm ci 自動建立 | reports 會累積且可能含主機識別資訊；每日排程消耗本機資源，應記錄檢討／停止日期。停用排程不會停止已裝在主機的 monitor |
| Docker、驗收映像、Gitleaks | 選用驗收環境，並非工具必要依賴 | Docker engine／VM 自身有 CPU、RAM、磁碟負擔；build 下載 Linux 套件，映像保留。systemd 驗收容器使用 privileged、1 GiB RAM／2 CPU 上限，無主機目錄／socket 掛載、無對外 port 或執行期網路；完成移除容器，映像需自行管理。Gitleaks 掃描以無網路、唯讀掛載執行 |
| ShellCheck | 選用 shell 靜態檢查；腳本不自動安裝 | 無此工具時只記錄 bash 語法檢查，不能宣稱已執行 ShellCheck |

`npm test` 會在本機建立測試暫存檔並使用 Bash，但不啟動 Docker、SSH 到實機或呼叫真實 AWS。完整 systemd 驗收須另執行 `node scripts/validate-monitor-lifecycle.mjs --run`，僅適合可信任的本機 Docker 環境。

## 目標主機與 AWS

| 功能 | 額外安裝／異動 | 效能、費用與風險 | 停止／回復 |
| --- | --- | --- | --- |
| SSH 唯讀 collector | 透過 SSH 執行暫時的 Bash 查詢；不新增 daemon 或應用程式檔案 | 讀取 proc、journal、歷史摘要等仍耗 CPU／I/O；大量 journal 或歷史會增加耗時，唯讀不等於零負擔。查不到 OOM 回報未知；查詢成功也不代表系統保留了完整 90 天 journal | 結束命令／停用本機排程；OS 自身仍可能留下 SSH／sudo 稽核日誌 |
| AWS collector | 本機 SDK 呼叫 STS／EC2 Describe／CloudWatch read API；不開啟 Detailed Monitoring | 不透過 EC2 執行計算，但 API 查詢可能計費或遇到限流；增加頻率、主機數及歷史窗會增加查詢量 | 停用本機查詢／排程；原有 AWS 監控仍繼續 |
| CloudWatch Agent（選用） | `cloudwatch-agent-install.sh --apply` 下載 RPM、以 dnf 安裝及相依套件解析、寫入 /opt/aws/amazon-cloudwatch-agent 設定、啟動／啟用服務；EC2 IAM role 另由操作者配置 | 常駐 CPU／RAM／網路及自身日誌；發布 RAM、swap、root disk custom metrics 可能計費。只支援全新安裝，拒絕覆蓋既有 Agent；中途失敗可能留下套件，沒有完整自動移除回滾 | 明確停用服務、確認後移除套件；不能任意移除其他服務共用的 IAM role。見 [安裝流程](cloudwatch-agent-installation.md) |
| PHP-FPM monitor（選用） | 安裝 sampler、systemd service／timer；修改 pool 的 status 設定與專用 Apache VirtualHost；重載 PHP-FPM／Apache。使用已存在的 jq、curl、Apache、PHP-FPM、systemd 等，缺依賴時停止，不自動安裝 | loopback 127.0.0.1:9081，每分鐘採樣；程序／PSS 讀取、35 天歷史有少量 CPU／I/O／空間用量。設定或重載失敗可能影響服務；記憶體／時間上限不等於所有主機已驗證 | 明確停用 timer；完整回復使用該次備份的 --rollback，保留歷史。沒有 PHP monitor --update。見 [PHP monitor](php-fpm-peak-monitor.md) |
| HTTP monitor（選用） | 安裝 sampler、輪替標記程式、systemd service／timer；新增 GlobalLog 與原生 rotatelogs 管線、專用 logrotate 註解占位，重載 Apache。需已存在的 rotatelogs、mod_env 等 | 每請求增加數字日誌寫入及常駐 rotatelogs 程序。兩個 10 MiB 循環檔可多出一個寫入 buffer；每批最多 1 MiB、sampler 64 MiB／10 秒上限、歷史 35 天。輪替／重載與超量跳過標記缺口，可能推遲有效觀測窗；高流量負載尚未驗收 | 停用 timer 只停止摘要，Apache 仍寫原始日誌；應使用備份 --rollback 移除／還原 GlobalLog，確認 Apache 後才算完整停止。舊日誌及歷史不自動清除。見 [HTTP monitor](production-rightsizing-observation.md) |
| crawler monitor（選用） | `crawler-light-monitor.sh --apply` 複製 sampler 與 systemd service，每五分鐘採樣；preflight 要求既有 sar／sysstat timer，不自動安裝 sysstat | 常駐 shell、程序掃描與歷史寫入，service 設 MemoryMax=32M；此 installer 不在 PHP／HTTP lifecycle 驗收範圍，也沒有既有檔案備份還原保護，不應覆蓋已客製化安裝 | --rollback 移除 sampler/service、保留歷史；不是還原任意先前設定。見 [crawler monitor](crawler-light-monitor.md) |
| 磁碟寫入盤點／PHP 調校 | disk-write-audit 是額外唯讀診斷；php-fpm-tune 是另外授權的設定修改 | 大量目錄／journal 掃描可能有明顯 I/O；不要視為高頻輕量監控。PHP 調校會更改 pool／重載，可能改變吞吐或延遲；不是每日 collector 的自動步驟 | 分別依 [磁碟診斷](disk-write-audit.md) 與 [PHP sizing](php-fpm-sizing.md) 的使用／回復說明 |

以上沒有保證零負擔或零停機。部署前確認版本、權限、可用 RAM／磁碟與回滾路徑；部署後觀察程序用量、應用延遲、日誌及 timer。CloudWatch 費用依區域、用量與帳戶方案而異，本文件不提供固定月費承諾。

## 全新安裝與資料相容性

1. 完成本機依賴、SSH alias 與唯讀 AWS profile 設定，先跑 `ops-audit check`。
2. 依需要選用監控；先在測試主機執行各腳本的 `--check`，審核上表影響後才明確執行 `--apply`。同時使用 PHP／HTTP monitor 時先安裝 PHP，再安裝 HTTP。
3. 確認服務、timer 與摘要正常後開始每日蒐集，累積至少 14 天具代表性的有效證據，再依分析 SOP 評估。

HTTP 全新安裝會記錄來源契約 `http-filtered-v1` 與有效起點 `valid-since`，並排除專用 PHP status VirtualHost 的內部探測。摘要格式版本只描述輸出格式，不能替代來源相容性驗證。來源版本不支援、起點未知、缺口紀錄不可讀或觀測窗早於有效起點時，工具回報資料不足，不會自動認證或修改既有資料。不要手工補版本欄位來通過門檻。

遇到不相容的既有安裝時，先停止升級操作，由管理者確認設定、備份與重新蒐集計畫；全新安裝不需要進行開發版遷移。安裝器會保存來源 metadata 供回滾使用。來源標記是相容性契約，不是防止有權修改主機檔案者竄改資料的密碼學證明。

Apache 條件式日誌的語義參考 [官方 mod_log_config 文件](https://httpd.apache.org/docs/2.4/mod/mod_log_config.html#globallog)。隔離驗收涵蓋 status 探測不增加網站計數，以及一般網站請求即使帶不同 Host port 仍被計數。
