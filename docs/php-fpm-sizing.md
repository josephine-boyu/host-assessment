# example-wp-staging PHP-FPM 設定候選

以下為匿名化並取整的設定示範，不代表任何主機的目前狀態。

假設一台約 2 GiB RAM 的測試站沒有 swap，PHP-FPM 採 `dynamic`、`pm.max_children=5`、`memory_limit=256M`；閒時 worker RSS 約 80 MB，但歷史高記憶體操作曾達約 180 MB 並發生 OOM。規劃時不能只採用閒時的 80 MB，仍須補實際 PSS、並行量與尖峰證據。

以下設定都是人工驗證用候選，不由 Host Assessment 自動修改主機。

## t3.small（約 2 GiB）

適合需要穩定支援約 4 個同時 PHP 請求，且希望保留測試、外掛更新及媒體處理餘裕的 staging。

```ini
pm = ondemand
pm.max_children = 4
pm.process_idle_timeout = 10s
pm.max_requests = 300

request_slowlog_timeout = 5s
php_admin_value[memory_limit] = 256M
```

- `ondemand` 讓平時無流量時不常駐多餘 workers。
- `max_children=4` 取自預期 PHP 並行數，而不是使用者人數。
- 以歷史高點約 181 MB 加 25% 餘裕估算，每個 worker 預算約 227 MB；4 個 workers 約 908 MB，2 GiB 主機仍可保留空間給 OS、Web Server 與 CloudWatch Agent。
- `max_requests=300` 用來定期回收 worker，降低長時間運作後的記憶體累積風險；實際數字仍應依 latency 與 RSS 趨勢調整。
- slow log 已啟用，應沿用現有安全路徑與 log rotation，不在本文件指定路徑。

## t3.micro（約 1 GiB）

只建議作可回復的受控實驗。1 GiB 扣除 OS、Web Server 與 CloudWatch Agent 後餘裕有限，不適合直接沿用 small 的 4 workers。

```ini
pm = ondemand
pm.max_children = 2
pm.process_idle_timeout = 10s
pm.max_requests = 200

request_slowlog_timeout = 5s
php_admin_value[memory_limit] = 192M
```

選用的 WordPress 上限：

```php
define( 'WP_MEMORY_LIMIT', '128M' );
define( 'WP_MAX_MEMORY_LIMIT', '192M' );
```

- `max_children=2` 是測試候選，不代表歷史最壞情況已有充足餘裕；第 3 個同時 PHP 請求會排隊。
- `memory_limit=192M` 與 WordPress 上限必須先驗證外掛更新、媒體處理、匯入、備份與後台操作；若功能失敗，應回復 `256M`，不能只為容納 micro 強制降低。
- 建議另行評估約 1 GiB 受控 swap 作短暫緩衝，但 swap 不能取代 RAM，且建立 swap 屬於主機變更，需獨立核准與回滾腳本。
- CloudWatch Agent 的實際 RSS 必須納入觀測；例如占用約 100 MiB 時，對 1 GiB 主機已不是可忽略的比例。

## 驗證與停止條件

1. 先備份現行 pool 設定，執行 `php-fpm -t` 或該版本對應的設定語法檢查，再 reload；不要直接 restart 且不留回滾方式。
2. 覆蓋登入、前後台瀏覽、外掛更新、媒體上傳/縮圖、排程與同時請求測試。
3. 同時觀察 RAM、swap-in/out、OOM、PHP-FPM queue、`max children reached`、HTTP 5xx 與延遲。
4. micro 若發生 OOM、持續使用 swap、queue/延遲超標或核心工作超過 memory limit，立即回復 t3.small 與原設定。

結論：t3.small 的建議起點是 `ondemand + max_children=4`；t3.micro 可從 `ondemand + max_children=2` 試驗，但若要穩定承擔 4 個 PHP 並行請求，應保留 small。

## 可稽核的 staging 變更腳本

以下腳本只應在操作者明確授權後使用；`--check` 唯讀，`--apply` 會備份、驗證並 reload PHP-FPM：

```bash
scripts/php-fpm-tune.sh --check example-wp-staging
scripts/php-fpm-tune.sh --apply example-wp-staging
```

成功時會輸出 `/var/backups/ops-toolkit/php-fpm/www.conf.<UTC時間>`。需要回復時，必須明確傳入該次備份路徑：

```bash
scripts/php-fpm-tune.sh --rollback example-wp-staging /var/backups/ops-toolkit/php-fpm/www.conf.<UTC時間>
```

腳本固定修改 `/etc/php-fpm.d/www.conf`，範例以已驗證的 Amazon Linux/PHP 8.3 環境為基礎；其他主機必須先各自執行 `--check` 並確認 pool 路徑，不可直接套用。
