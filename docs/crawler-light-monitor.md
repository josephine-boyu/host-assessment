# 輕量 crawler 主機監控

此方案用於 RAM 很小、不適合常駐 CloudWatch Agent 的 crawler 主機。系統層 RAM/load/swap/I/O 沿用 Amazon Linux 已啟用的 `sysstat/sar`；Host Assessment 只補 crawler process tree 的 5 分鐘歷史。

## 介面

```bash
scripts/crawler-light-monitor.sh --check example-crawler-staging
scripts/crawler-light-monitor.sh --apply example-crawler-staging
scripts/crawler-light-monitor.sh --summary example-crawler-staging 14
scripts/crawler-light-monitor.sh --rollback example-crawler-staging
```

`--apply` 會安裝約數 MB 的常駐 Bash sampler，每 5 分鐘記錄：RAM total/available、swap used、load 1m、root disk、crawler process 數量，以及整棵 process tree 的 RSS sum/max。它以 process `comm` 的 `run_day_session` 或 `day_session_loo` 作為根，再包含所有子程序，不讀取可能含 token/URL 的 command line。

每日 TSV 位於 `/var/lib/ops-toolkit/crawler-history/`，只保留 35 天。`--rollback` 會停用並移除程式與 systemd unit，但刻意保留歷史資料，避免破壞盤點證據。

現有 SSH host collector 會自動讀取最近 14 天 TSV 摘要，寫入每日 `host.json` 的 `crawler_monitor`，並顯示在 host Markdown；因此既有 `daily-all` 排程就是每日取回機制，不需新增 Windows 排程。

這是硬體匹配監控，不包含爬蟲成功率、queue backlog、重試或封鎖率。原始 TSV 與摘要仍可能包含主機運作資訊，分享前需檢查。
