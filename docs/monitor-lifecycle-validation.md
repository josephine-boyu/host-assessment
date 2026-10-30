# 監控安裝／回滾驗收

此驗收針對 PHP-FPM 與 HTTP monitor 的安裝腳本，使用 Amazon Linux 2023 容器內真正的 systemd、Apache、PHP-FPM 與 logrotate。不是 WordPress 業務測試，也不會連線 AWS 或既有主機。

## 已驗證結果（2026-10-30）

完整 runner 以 exit code 0 結束，所有下列 lifecycle 情境通過；測試容器已停止並刪除。實測套件為 systemd 252、Apache 2.4.69、PHP-FPM 8.5.12、logrotate 3.20.1。這份結果只適用於列出的測試組合，不代表其他 PHP／OS 版本都已驗證。

對應版本的一般測試 88／88 通過；19 個公開 shell 檔案通過 LF 與 `bash -n`。故障注入必須出現指定的失敗訊息才算命中，不能把任意失敗當成回滾驗收通過。

## 執行方式

需要本機 Node.js、Docker Linux engine，以及允許建立 privileged 測試容器的環境：

```powershell
node scripts/validate-monitor-lifecycle.mjs --run
```

建立映像時會下載 Linux 套件。`.dockerignore` 僅允許測試需要的 monitor 設定、腳本及 integration tests 進入 build context，不包含 local 設定、金鑰、reports 或 Git 歷史。

執行容器使用獨立 cgroup namespace、1 GiB memory 上限、2 CPU 上限與 512 PID 上限；無主機目錄或 Docker socket 掛載、無對外 port、無執行期網路。privileged 是為了讓 systemd 真正執行 mount namespace 等服務隔離，仍具有較高 Docker engine 權限，應只在可信任的本機測試環境執行。runner 最後停止並刪除自己的容器；測試映像保留供重跑使用。

一般 `npm test` 不會啟動此驗收。SSH／SCP 以有固定測試目標與容器防護的本地 adapter 取代，安裝腳本本身照常執行；不驗證 SSH 驗證或傳輸。

## 驗收項目

- PHP-FPM：preflight、首次安裝、重複安裝拒絕、loopback brief status、systemd timer 實際觸發、手動回滾、錯誤 Apache 設定及服務啟動失敗自動回滾。
- HTTP：首次安裝、重複安裝拒絕、更新、更新回滾、服務啟動失敗時自動回滾、首次安裝回滾。
- logrotate：與系統 Apache 通用規則共存、強制輪替後匿名日誌仍持續寫入；專用規則只保留註解，不再重複管理循環檔。
- HTTP rotatelogs：輸入超過 30 MiB 後確認僅兩個 10 MiB 循環檔（允許寫入 buffer 超出）、current hard link 及輪替缺口標記。一般測試另驗證 1 MiB 批次上限、跳過後復原、半行延後處理及缺口阻擋試降。
- HTTP timer 實際觸發；回滾後檢查設定內容、服務與 timer 狀態、歷史資料保留，以及網站仍能回應。
- 備份複製中途失敗：現有設定及 timer 不變，不完整備份不得用於手動回滾。
- HTTP timer 原本 enabled 但 inactive：回滾後仍保持停止，不因 enabled 而擅自啟動。
- PHP／HTTP 同時安裝：連續呼叫內部 status 不增加網站請求數；改動 Host header 的內部請求仍排除，正常網站請求仍計數。舊 PHP VirtualHost 未設定排除標記時，HTTP preflight 拒絕繼續。
- 一般回歸驗證 HTTP 來源契約：缺少可信來源版本時不得沿用有效起點，相容來源則保留；本機更新不能讓來源不明的歷史通過降規判斷。

## 安全保護

- preflight 的管線完整讀取上游輸出，避免 `grep -q` 提早關閉造成 `pipefail` 誤報 SIGPIPE（141）。
- 備份目錄以排他方式建立；同秒重跑若撞名會停止，不覆寫舊備份。
- 完整備份前不執行自動復原，未完成的備份留下 `backup.incomplete` 並拒絕手動回滾。
- HTTP 更新先停止 timer 與正在執行的 sampler，再更換檔案。回滾分開還原 enabled／active 狀態。
- HTTP 來源版本與有效起點 metadata 納入備份、手動及故障自動回滾；首次安裝回滾會移除新建來源標記。
- HTTP 輪替標記程式也納入備份、失敗復原與手動回滾。preflight 檢查 rotatelogs 與 128 MiB 可用日誌空間；這不是對整台主機未來磁碟用量的保證。

## 範圍限制

這是隔離 systemd lifecycle 驗收，不代表已完成所有 EC2 映像相容性測試。EC2 IAM、security group、SSH 權限、SELinux enforcing、自訂 Apache VirtualHost 與既有 pool 差異，仍須各主機先執行唯讀 `--check`，再明確授權部署。CloudWatch Agent、crawler 及 PHP 容量調整腳本不屬於這次兩個 monitor 的驗收範圍。

PHP monitor 目前沒有 `--update` 模式；不能將 HTTP 的更新驗收推論成 PHP 支援原地更新。
