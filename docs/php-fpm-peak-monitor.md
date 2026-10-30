# PHP-FPM 尖峰監控

## 目的與決策邊界

這組監控補足每日 SSH 快照看不到的 PHP-FPM 尖峰，收集 active/idle、listen queue、max active、`max children reached`、slow requests，以及 worker RSS/PSS 高水位。它只保存數字，不保存 request URI、HTTP method、使用者、Cookie、POST body、WordPress 資料或資料庫內容。

PHP-FPM 歷史足以協助判斷 pool 是否飽和、`pm.max_children` 是否過高或過低、worker 記憶體預算及是否需要 `pm.max_requests`。它**不能單獨支持整台主機升降規**。正式 rightsizing 仍須結合至少 30 天 CPU、RAM、swap、I/O、network、CPU credit、OOM、延遲／5xx，以及至少一次 PDF 寄信等已知業務尖峰。

## 安全與低負擔設計

- PHP-FPM status 綁定獨立的 `127.0.0.1:9081` Apache listener，不修改 Security Group，也不在 public vhost 公開。
- collector 固定讀取 brief JSON，禁止 `full`；因此不會取得每個 worker 的 URI、script 或使用者資訊。
- 一分鐘執行一次 systemd oneshot，不建立常駐 SSH、不常駐 Bash 程序；每次 curl timeout 為 2 秒，service timeout 為 10 秒。低成本的 status／RSS 每分鐘取樣，較重的 PSS 頁表讀取每 5 分鐘取樣一次。
- service 只允許連 localhost，只能寫 `/var/lib/ops-toolkit/php-fpm-history`，並啟用 `NoNewPrivileges`、唯讀系統目錄、kernel／device 防護與 64 MB memory limit。為讀取不同 UID PHP worker 的 `/proc/*/smaps_rollup`，capability bounding set 只保留 `CAP_SYS_PTRACE`；腳本是 root-owned、固定命令且每次最多執行 10 秒，不保留其他 capability。
- 每日 TSV 權限受 `umask 0027` 限制，只保留 35 天。以目前 20 個數值欄位估算，磁碟量通常是數十 MB 以下；仍須在實機量測。
- `--apply` 前先檢查 socket、工具、服務與 port 衝突；備份設定後執行 `php-fpm -t` 及 `apachectl configtest`，成功才 reload。
- apply 任一步驟失敗會恢復 PHP-FPM／Apache 設定、reload 原設定並移除新 unit。顯式 rollback 會保留歷史資料，避免破壞稽核證據。
- 安裝流程不調整 `pm.max_children`、`pm.max_requests`、slowlog、WordPress、外掛、theme、uploads 或 RDS；監控與調校保持分離。

## 檔案與異動範圍

正式套用時才會異動下列位置：

- `/etc/php-fpm.d/www.conf`：只設定 `pm.status_path = /ops-toolkit-fpm-status`。
- `/etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf`：新增 loopback-only vhost。
- `/usr/local/libexec/ops-toolkit-php-fpm-monitor`：root-owned 採樣器。
- `/etc/systemd/system/ops-toolkit-php-fpm-monitor.{service,timer}`。
- `/var/lib/ops-toolkit/php-fpm-history/`：數值 TSV。
- `/var/backups/ops-toolkit/php-fpm-monitor/<UTC時間>/`：回滾備份。

不會新增對外監聽；驗證時必須確認 `ss` 只顯示 `127.0.0.1:9081`。

## 操作方式

所有遠端步驟都必須由操作者逐台明確授權。先執行唯讀 preflight：

```bash
scripts/php-fpm-monitor.sh --check example-wp-production
```

套用會修改環境設定並 reload PHP-FPM／Apache：

```bash
scripts/php-fpm-monitor.sh --apply example-wp-production
```

取回 14 天摘要及回滾：

```bash
scripts/php-fpm-monitor.sh --summary example-wp-production 14
scripts/php-fpm-monitor.sh --rollback example-wp-production /var/backups/ops-toolkit/php-fpm-monitor/<UTC時間>
```

每日 `collect`／`daily` 也會在歷史存在時自動讀取最近 14 天摘要，寫入 `php_fpm_monitor`，不取回逐分鐘原始檔。

## 本機測試與正式站驗收

本機測試使用假的 brief status JSON 與 `/proc` fixture，確認 RSS/PSS、queue、swap 等欄位、輸出不含 request 資訊，以及 systemd／Apache 安全限制。執行：

```powershell
node --test test/php-fpm-monitor.test.mjs
npm.cmd test
```

本機 fixture 無法完整模擬 Amazon Linux 2023 的 systemd、SELinux、Apache module 與實際 socket ACL。正式套用前後仍須完成：

1. `--check` 通過，確認 9081 無衝突。
2. PHP-FPM 與 Apache configtest 成功，兩個服務 reload 後仍為 active。
3. `ss` 只出現 `127.0.0.1:9081`，從外部無法存取 status。
4. timer/service active，首次 TSV 僅含預期的 20 個數值欄位。
5. 驗證網站首頁、登入及 PDF／寄信流程。
6. 觀察 24～48 小時 service duration、失敗次數、CPU、RSS、journal 與磁碟成長；若負擔或錯誤不符預期立即 rollback。

## 判讀時程

- 24～48 小時：確認監控本身安全、穩定且低負擔，不做規格結論。
- 7～14 天且涵蓋一次 PDF 操作：可提出 PHP-FPM pool 調校候選。
- 30 天且 coverage 至少 90%、涵蓋已知尖峰：才與 CloudWatch、OOM、延遲／錯誤資料合併評估主機規格。
- 若沒有涵蓋活動、月底或其他特殊尖峰，延長觀察，不以缺少事件當成低負載證據。
