# WordPress／PHP-FPM 主機試降案例

這是第三層的選讀案例；通用分析流程見 [分析 SOP](../sop/rightsizing-analysis.md)。以下設定是待驗證候選，不代表已完成硬體試降或證實降規成功。

這是一個經過匿名化與四捨五入的實務案例，用來說明如何從 14 天監控資料評估 AWS EC2 WordPress 主機。數值只保留判斷方法所需的量級，不代表任何特定網站。

## 案例背景

一台 2 vCPU／8 GiB RAM 的 WordPress 主機使用外部資料庫，PHP-FPM 採 `dynamic`，原始 `pm.max_children` 設為 50。團隊希望評估能否降至同為 2 vCPU、但只有 4 GiB RAM 的較小規格。

觀測資料涵蓋：

- CloudWatch CPU、network、EBS 與 status checks。
- CloudWatch Agent RAM、swap 與 root filesystem。
- 每分鐘 PHP-FPM brief status、worker RSS／PSS 與 available RAM。
- 每分鐘匿名 HTTP status／latency；不保存 IP、URL query value、Cookie或 request body。
- 一次已知的高記憶體業務操作事件。

## 14 天觀測摘要

經過匿名化與區間化後的主要結果：

| 指標 | 觀測結果 |
| --- | ---: |
| CPU 平均 | 約 2% |
| CPU daily p95 | 約 5% |
| CPU 瞬間最高 | 約 50% |
| RAM 平均 | 約 17% |
| RAM 瞬間最高 | 約 35% |
| OOM | 0 |
| Root disk | 約 65% |
| EBS queue | 低於 0.2 |
| HTTP requests | 約 20 萬 |
| HTTP 5xx rate | 約 0.1% |
| PHP active workers | 高十位數 |
| PHP listen queue | 未見持續排隊 |
| 單 worker PSS 高點 | 約 125 MB |

只看 CPU、RAM 與 EBS，原主機明顯有餘裕。但這不足以直接降規：PHP-FPM 曾記錄一次 `max children reached`，HTTP 也出現一段大量約 120 秒的 FastCGI timeout。

## 先找出歷史異常

匿名 HTTP monitor 只知道 status 與 duration，不知道實際路由。針對 timeout 時段，再由主機端就地聚合既有 access／error log，只輸出去識別化路徑、允許的 action label、status 與次數，發現：

- 某個前台篩選 AJAX action 在約半小時內發生數十次 504。
- Apache 同時出現 `AH01075`／FastCGI timeout。
- 使用者看到很慢的頁面本身多半回 200；真正占住 worker 的是頁面呼叫的 AJAX handler。

應用程式後續已優化該 handler。因此，修正前的 timeout、worker 堆積與 `max children reached` 不能直接當成修正後容量需求。做 rightsizing 時，部署效能修正應建立新的有效觀測起點；否則滾動 14 天視窗會混入已不存在的問題。

## PHP-FPM 記憶體算法

使用 worker PSS，而不是直接加總 RSS。RSS 會把 shared pages 在多個 process 重複計算，通常高估實際記憶體。

保守算法：

```text
worker_budget = observed_worker_pss_peak × 1.25
reserved_non_php = max(512 MiB, total_ram × 35%)
available_for_php = total_ram - reserved_non_php
memory_capacity_children = floor(available_for_php / worker_budget)
```

以約 125 MB PSS 為例，安全 worker budget 約為 156 MB：

| 主機 RAM | 非 PHP 保留 | PHP 可用 | 保守 worker 容量 |
| ---: | ---: | ---: | ---: |
| 約 8 GiB | 約 2.7 GiB | 約 5.0 GiB | 約 32 |
| 約 4 GiB | 約 1.4 GiB | 約 2.6 GiB | 約 17 |

這是在上述假設下的容量估計，不是硬體保證上限，也不是建議直接填入的 `pm.max_children`。25% 安全係數與 35% 保留量是此案例的啟發式假設；PSS 也會隨 worker 數與共享頁面改變。最終候選還要參考修正後 active workers、queue、延遲與業務尖峰。

## 在大主機預演小主機的 PHP 上限

直接降規前，可以先在 8 GiB 主機套用 4 GiB 目標的 PHP-FPM profile：

```ini
pm = dynamic
pm.max_children = 16
pm.start_servers = 3
pm.min_spare_servers = 3
pm.max_spare_servers = 6
pm.max_requests = 300

request_slowlog_timeout = 5s
php_admin_value[memory_limit] = 256M
```

這能預演：

- 16 workers 是否足以支援真實並行量。
- 超過上限時 queue 與 latency 是否仍可接受。
- AJAX、PDF、寄信、媒體與後台工作是否正常。
- `max children reached`、5xx 或 timeout 是否再發生。

它不能完整模擬 4 GiB 主機，因為 OS、Apache、filesystem cache與其他程序仍可使用 8 GiB RAM。不要在 production 以 cgroup 強制壓縮整機記憶體來模擬；風險通常高於收益。

`request_slowlog_timeout` 必須搭配明確的 `slowlog` 路徑、權限與 logrotate。尚未理解合法長工作前，不要直接加入 `request_terminate_timeout`。

## Swap 是保護，不是容量

對 4 GiB 試降主機，可考慮建立 2 GiB swapfile，並以低 swappiness（例如 10）作為瞬間尖峰保護。

Swap 的正確用途：

- 降低瞬間尖峰直接觸發 OOM 的機率。
- 讓監控與人工回滾有反應時間。

Swap 的錯誤用途：

- 長期支撐超過 RAM 的 worker 數。
- 用持續 swap-in／swap-out 掩蓋容量不足。

除了 swap 使用量，也要觀察 swap-in／swap-out、available RAM 與 latency。256 MB 可作為調查提示，不能單憑占用量判定試降失敗；冷頁面留在 swap 不代表持續發生 paging。

## 可回復的試降流程

1. 記錄應用程式效能修正時間，建立修正後基線。
2. 備份 PHP-FPM pool 設定；準備 syntax check、reload 與回滾。
3. 在原規格套用目標規格的 PHP profile，觀察至少 7 天並涵蓋核心業務操作。
4. 建立受控 swap，確認監控與重開機後仍有效。
5. 選低流量且可接受停機的窗口，停止 EC2、修改 instance type、再啟動。
6. 立即驗證登入、前台查詢、後台、排程與高記憶體工作。
7. 先密切觀察 1～2 小時，再持續觀察至少 7 天。

EC2 EBS-backed instance 的 type 變更是可逆的，但需要 stop／start，會中斷當下請求與背景工作。外部資料庫與 EBS 資料不會因單純改變 instance type 而消失；IP 保留方式仍須依實際網路設定確認。

## 停止與回滾條件

以下條件應事先寫進 runbook，而不是事故發生後才討論：

- 發生 OOM 或服務無法啟動。
- RAM 持續超過 85%。
- 持續 swap-in／swap-out，伴隨可用 RAM 不足或延遲惡化。
- PHP-FPM listen queue 持續大於 0。
- `max children reached` 反覆增加，並伴隨持續排隊或服務品質惡化；單次增加先調查。
- HTTP 5xx rate 達 1% 或顯著高於基線。
- p95 latency 持續超過 3 秒。
- 再次出現接近上游 timeout 的長請求群聚。
- 任何核心業務流程失敗。

回滾時先恢復原 instance type。PHP-FPM 上限可以暫時維持較小值，以判斷問題究竟來自 RAM 還是請求並行；不要在事故中直接恢復未經記憶體預算驗證的極大 worker 上限。

回滾仍需要停機窗口與可用的雲端容量，恢復規格不會自動補回中斷的工作或撤銷重複寄信。此工具尚未實作自動試降與自動回滾。上述百分比與延遲門檻是案例候選，實際須約定持續時間、最少請求量及業務可接受範圍。

## 可公開監控的隱私邊界

預設長期 monitor 應保存數值而非請求內容。需要事件診斷時，可提供額外的唯讀、限時、就地聚合流程：

- 輸入 UTC 時間窗。
- 僅輸出正規化路徑、允許列出的 action label、status 與計數。
- 在主機端移除 IP、query value、referer、user-agent、Cookie 與 request body。
- 將診斷輸出保存在被 Git 忽略的 reports，公開前再匿名化。

這種分層設計能同時保留長期低風險監控與事故期間的可診斷性。

## 決策重點

「曾經碰到 max children」不等於永遠不能降規；它可能是慢 API 把 workers 長時間占住的結果。正確流程是先修正長請求、重建基線、在原規格預演較小 pool，再進行有監控與回滾的硬體試降。

這個案例的可重用結論是：rightsizing 不是只看平均 CPU，也不是只把 RAM 除以單 worker 記憶體；必須同時考慮應用程式變更時間、PSS、並行量、queue、timeout、swap 與可回復的操作流程。
