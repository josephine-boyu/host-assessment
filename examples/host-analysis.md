# 主機分析報告：example-wp-staging

- 收集時間：2026-01-15T02:00:00.000Z
- 分析時間：2026-10-27T05:36:56.269Z
- 整體等級：Warning
- 雲端規格：aws / t3.small
- CPU / RAM：2 vCPU / 1913 MB

## 收集事實

- Hostname：example.internal
- OS / Kernel：Example Linux / 6.1.example
- Uptime：1 天 0 小時
- Load 1m：0.08
- Available RAM / Swap：1180 MB / 0 MB
- Root disk：42%
- Web：httpd（active=active, enabled=enabled, restart=no）
- PHP-FPM：php-fpm（pm=dynamic, max_children=5, memory_limit=256M）
- PHP workers：2（RSS avg=82 MB, max=128 MB）
- PHP slow log：未偵測到
- Local DB：未偵測
- WP-Cron system trigger：已偵測
- OOM（90 天）：0
- PHP-FPM monitor：尚無歷史資料
- HTTP monitor：尚無匿名 latency／5xx 歷史

## PHP-FPM 設定候選

- 狀態：可供驗證的候選值
- 候選設定：pm=ondemand、pm.max_children=3、pm.max_requests=300
- 閒置回收：pm.process_idle_timeout=10s
- 計算：總 RAM 1913 MB - 非 PHP 保留 670 MB = PHP 可用 1243 MB
- Worker 預算：snapshot_rss 128 MB × 1.25 = 160 MB
- 容量：最多 7 workers；預期 PHP 並行數 3
- 信心：medium（單次 RSS 快照僅適合作為初始候選）
- 套用方式：不會自動套用；須先在測試站驗證並準備回滾。

## 分析結果

### Warning：低記憶體主機沒有 swap 緩衝

- 代碼：`low_memory_without_swap`
- 信心：high
- 證據：`{"memory_total_mb":1913,"swap_total_mb":0}`
- 建議：評估建立受控 swap 作為瞬間尖峰緩衝，並同步監控 swap-in/out；swap 不能取代足夠 RAM。

### Recommendation：PHP-FPM slow log 尚未啟用

- 代碼：`php_slowlog_disabled`
- 信心：high
- 證據：`{"service":"php-fpm"}`
- 建議：在確認路徑、權限、rotation 與效能影響後，於觀測期間啟用 request_slowlog_timeout。

### Recommendation：httpd 未設定 systemd 自動重啟

- 代碼：`web_restart_disabled`
- 信心：medium
- 證據：`{"service":"httpd","restart_policy":"no"}`
- 建議：先確認既有監控與復原方式，再評估使用適合的 Restart policy；這不是所有環境都必須變更。

### Recommendation：尚未取得 PHP-FPM 尖峰歷史

- 代碼：`php_fpm_peak_history_missing`
- 信心：high
- 證據：`{"snapshot_worker_count":2,"snapshot_worker_rss_max_mb":128}`
- 建議：以 localhost-only status 與低負擔 sampler 收集 active、queue、max children reached、RSS/PSS；不要公開 full status。

### Recommendation：尚未取得匿名 HTTP latency／5xx 歷史

- 代碼：`http_performance_history_missing`
- 信心：high
- 證據：`{}`
- 建議：僅保存 timestamp、status 與 duration 的數值彙總，不收 IP、URL、Cookie 或 request body。

### Recommendation：已依 RAM、worker RSS 與預期並行數產生 PHP-FPM 候選值

- 代碼：`php_fpm_candidate_available`
- 信心：medium
- 證據：`{"pm":"ondemand","max_children":3,"max_requests":300}`
- 建議：先在測試站套用、壓測並觀察 queue、max children reached、OOM 與延遲，再人工核准正式站設定。

### Info：單次快照不足以支持降規

- 代碼：`snapshot_not_enough_for_downsize`
- 信心：high
- 證據：`{"observation_type":"snapshot","php_fpm_history_available":false}`
- 建議：PHP-FPM 歷史可支持 pool 調校，但整機降規仍需至少 14～30 天 CPU、RAM、I/O、網路、延遲、錯誤率與業務尖峰證據。

## 限制

PHP-FPM 尖峰資料可用來判斷 pool 飽和與 worker 記憶體，但不能單獨支持整機升降規；仍需結合至少 14～30 天 CPU、RAM、I/O、網路、延遲、錯誤率與已知業務尖峰。

本報告只提出唯讀分析與候選建議，不會自動修改主機或雲端資源。設定與規格變更需人工核准並準備回滾。
