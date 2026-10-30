# Windows Task Scheduler

## 排程範例

- Task name：`ops-toolkit-example-wp-staging`
- Windows user：目前登入且可存取 SSH／AWS 使用者設定的本機帳號
- Trigger：每天本機時間 08:20（Asia/Taipei）
- Action：`config/daily-all.local.cmd`
- 權限：Limited、Interactive logon
- 設定：錯過時間後補跑、需要網路、10 分鐘 timeout、失敗每 5 分鐘重試最多 3 次、禁止重複併行
- 輸出：各啟用專案位於 `reports/history/<UTC日期>/<ssh-target>/`，批次摘要為同日的 `batch-manifest.json`

排程只在該使用者登入時執行，不在 Task Scheduler 保存 Windows 密碼。電腦若長期關機或未登入，就不會形成完整每日資料；此時應改用 CI 或獨立管理主機。

## 本機設定

實際 action 使用未追蹤的 `config/daily-all.local.cmd`，內含本機設定檔與執行檔路徑，不含 Access Key 或 Secret。可提交的格式範例為 `config/daily-all.example.cmd`。排程名稱由操作者自訂；實際執行範圍以 `config/projects.local.json` 的 `enabled` 為準。

AWS credential 保存在使用者 `.aws` 目錄，SSH 設定與私鑰保存在使用者 `.ssh`／既有 SSH 路徑；兩者都不進入 repo。

## 驗證

設定後先手動觸發，確認 `LastTaskResult=0`、batch manifest 無失敗，且只包含預期的啟用目標。可用 PowerShell 唯讀查詢：

```powershell
Get-ScheduledTask -TaskName 'ops-toolkit-example-wp-staging'
Get-ScheduledTaskInfo -TaskName 'ops-toolkit-example-wp-staging'
```

`LastTaskResult=0` 代表上次成功。非零時先查看 Task Scheduler History，再確認網路、repo 路徑、Node.js、AWS profile、SSH config 與私鑰權限。

## 安全邊界

- 排程只對 `enabled: true` 的專案執行 `daily-all` SSH/AWS 唯讀收集與本機報告寫入。
- `include_in_daily_all: false` 會讓專案保留單台執行能力，但不加入無參數的 08:20 批次；適合在一般批次時間預期已關機的 crawler。
- 例如 `ops-toolkit-example-crawler-staging` 每日 00:15 單獨執行 crawler，使用相同 Interactive/Limited、安全 timeout 與唯讀 wrapper。若 Windows 使用者未登入或 crawler 尚未啟動，該次仍可能無法收集。
- 排程不安裝套件、不修改 EC2、不修改 CloudWatch、不重啟服務。
- 調整 task action、principal、權限或 credential 前需重新人工確認。
- 同一天重跑會更新當日檔案；不同 UTC 日期各自保存。
