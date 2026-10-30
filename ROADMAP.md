# 優化項目與開發階段

此文件描述目前能力與後續規劃；功能支援與驗收範圍應分別確認。

本工具以唯讀盤點、可解釋的設定建議與人工審核的容量評估為目標。盤點與變更分離；安裝、調校與回滾必須明確執行，不由分析結果自動觸發。

## 首版已完成：限定範圍的 0.x

### 多專案盤點與報告

- [x] Linux／WordPress SSH 快照、CPU／RAM／swap／磁碟／PHP-FPM／OOM 檢查，以及 JSON／Markdown 報告。
- [x] projects 設定接受 `linux`、`wordpress`、`crawler`；共用 Linux／AWS 蒐集流程。這不代表三種 workload 都有完整降規決策器。
- [x] `ops-audit check` 檢查本機設定，不連線主機；`daily-all` 執行已啟用 AWS 專案、隔離 profile、允許指定單台與批次略過。
- [x] 單台失敗不終止其餘專案；每日保存結果及 batch manifest。
- [x] 使用 SSH alias、AWS named profile；憑證不寫入專案設定。Windows 排程範本與操作說明已提供。
- [x] CLI executable 宣告、匿名範例與離線示範。

### AWS 與歷史證據

- [x] AWS SDK 讀取 EC2 規格、attached EBS 與 CloudWatch；支援分頁、資料缺口及來源時槽 coverage。
- [x] 以 instance ID 核對 host 與 AWS 證據；目前沒有獨立的全帳戶 discovery／inventory 指令。
- [x] CPU、CPU credit、網路與 EBS IOPS／throughput／queue／latency 尖峰；自動讀取已有的 CWAgent RAM、swap、root disk 指標。
- [x] PHP-FPM loopback status、active／queue／counter、worker RSS/PSS，以及 HTTP 數值日誌與 latency／5xx 摘要。
- [x] HTTP 原始日誌循環容量、單批處理上限、缺口標記、來源版本與有效起點驗證；未知資料不能補零。
- [x] `window-report` 從保留來源重新彙整明確時區的指定期間；不能重建已刪除或從未蒐集的資料。
- [x] crawler 輕量本機歷史 sampler，記錄資源與程序 RSS／數量；不含應用成功率或 queue 決策。

### 分析與人工決策

- [x] 根據 RAM、worker 記憶體、預期並行數提出 PHP-FPM 設定候選與計算依據。
- [x] `assess recommend` 提供風險與調校方向；`assess target` 比較操作者提供的目標規格，目前限 AWS WordPress。
- [x] 比較目標 RAM、CPU baseline、network 與 instance EBS 能力；規格來源、時效及相容性仍須人工核對。
- [x] 14 天試降門檻包含 coverage、PHP／HTTP 健康、OOM、EC2 health、EBS 及同主機的必要業務事件。
- [x] 區分資料不足、維持、調校與試降候選；保留同時存在的風險理由，不自動變更主機。
- [x] 工具、分析 SOP、匿名案例三層入口，以及安裝依賴、費用、負擔與回滾限制文件。

### 安全與可重現驗證

- [x] 明確公開檔案白名單、敏感內容掃描、拒絕 symlink／junction／路徑穿越、獨立公開 AGENTS。
- [x] 一般測試、匿名示範、shell 語法檢查與獨立秘密掃描流程。
- [x] PHP／HTTP monitor 在隔離 Amazon Linux／systemd 中完成安裝、更新、故障復原與回滾驗收。
- [x] GitHub CI workflow 已提供；執行結果應以各版本的 CI 記錄為準。

發布流程與檢核項目見 [發布指南](docs/public-release.md)。

## 首版後優先：改善分析與操作

- [ ] 在現有 AWS 評估基礎上，自動列出一至兩個同雲候選機型，區分升規、降規、改 family 與先調設定；不把「有餘裕」當作「可直接變更」。
- [ ] 加入動態價格與完整成本比較：VM、磁碟、snapshot、網路、IP、監控及 burst 費用；區分牌價與合約／承諾折扣。
- [ ] 將穩定 SOP 封裝為可安裝 Skill，提供訪談與報告模板。
- [ ] 增加可驗證的品質門檻設定、跨報告趨勢、監控退場提醒與報告 retention；不能讓參數默默繞過證據不足。
- [ ] 提供經白名單打包的發行 ZIP；需要時再提供操作者端 Docker runner，不要求目標主機安裝 Node.js／Docker。

## 後續擴充：雲端、workload 與驗收範圍

- [ ] GCP inventory／Cloud Monitoring collector、身分與來源配對、資料品質測試；尚未實作，不能由 AWS 支援推論為已支援。
- [ ] 獨立 AWS 全帳戶／區域 inventory，以及無 SSH 情境的報告。
- [ ] SSO／AssumeRole 與 GCP impersonation 的完整操作驗收、連線式權限 preflight、去機密的 API audit log。
- [ ] crawler、容器與資料庫的專屬容量規則，先維持硬體／軟體匹配範圍；應用層成功率、重試與 queue 分析若有需求，另定範圍。
- [ ] 更多 OS、PHP、Web Server、SELinux 與高流量組合驗收；以實測 CPU、RAM、I/O、日誌容量及應用延遲確認監控負擔。
- [ ] CloudWatch Agent 與 crawler installer 的完整安裝／回滾驗收；不沿用 PHP／HTTP lifecycle 結果宣稱已驗證。
- [ ] 跨雲候選比較與 Arm 相容性檢查；不同 CPU 世代、架構與 burst 機制不視為等效。

## 參考

- [分析 SOP](docs/sop/rightsizing-analysis.md)
- [安裝與影響清單](docs/installation-and-impact.md)
- [公開版發布指南](docs/public-release.md)
- [驗收範圍](docs/monitor-lifecycle-validation.md)
- [跨雲比較設計](docs/cloud-rightsizing.md)
