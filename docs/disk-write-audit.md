# 磁碟寫入來源盤點

`scripts/disk-write-audit.sh` 是唯讀診斷腳本，用於找出 Linux 主機的磁碟容量、journal/log、近期大檔、deleted-open files 與程序累積寫入量。它不安裝套件、不清除檔案，也不修改 log 或服務設定；主要目錄掃描有 20～30 秒 timeout。

```bash
scripts/disk-write-audit.sh example-crawler-staging
```

原始輸出可能包含帳號、目錄及服務資訊，應保存於被 Git 忽略的 `reports/disk-write-audit/`，分享前先去識別化。

## 判讀方法

- 累計寫入量不等於磁碟永久成長。例如兩週寫入數十 GB，同時 filesystem 使用量穩定，可能是覆寫或日誌輪替。
- 同時比較容量、inode、journal/log 大小、EBS latency／queue 與程序寫入速率。
- `/proc/<pid>/io` 是程序啟動後累積量；兩次快照的差值除以間隔才接近該段速率。
- 檢查 deleted-open files；檔案已刪除但程序仍持有時，空間可能尚未釋放。
- 真實主機的日期、識別與精確量測保留於私人營運紀錄。

## 判讀與建議

系統網路維護服務也可能產生日誌。先確認它是否成功執行、有無異常重試及實際瓶頸，不要只因寫入多就停用。

可先維持現況並觀察：

1. 每週確認 root disk 使用率與 journal 實際占用是否穩定，以及輪替是否成功。
2. 若 journal 超過 root disk 的 10%、磁碟成長、EBS latency/queue 上升，或產生 snapshot 增量成本，再評估限制 journal 保留容量。
3. 若未來要降低寫入量，先在相同 Amazon Linux 版本的非正式環境驗證官方 `ec2net` 行為；不要直接停用 production/staging 網路 timer。
4. 程序 `write_bytes` 是自 process 啟動後累積值，不是即時速率；判斷尖峰來源仍需兩次快照差值或低負擔歷史 collector。
