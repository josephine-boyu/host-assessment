# Security Policy

## Supported versions

本專案目前仍在 `0.x` 階段，只維護預設分支的最新版本。使用前請先在 staging 驗證；任何會修改主機或雲端資源的操作都需要人工核准與回滾方案。

## Reporting a vulnerability

請使用 GitHub repository 的 private vulnerability reporting；若該功能尚未啟用，請由維護者提供的私人聯絡管道回報。不要在公開 issue 貼出：

- 密碼、token、access key 或私鑰；
- 真實 IP、hostname、AWS account／instance／volume ID；
- SSH config、完整環境變數或未去識別化報告；
- 客戶、訂單、email、request body 或 access log。

回報時請提供受影響版本、最小重現步驟、預期／實際結果與已去識別化證據。維護者確認前，不要掃描不屬於你的主機或帳戶。

## Security boundaries

- 健檢與 collector 預設唯讀；修復、安裝及 rollback 使用獨立且明確的模式。
- SSH 優先使用使用者的 `~/.ssh/config`；repo 不保存私鑰。
- AWS collector 應使用 least-privilege read-only IAM profile；EC2 Agent 應使用 instance role。
- `reports/` 與本機設定預設不進 Git；公開前仍須人工檢閱輸出。
- 本工具不是弱點掃描器，也不保證主機、WordPress 或雲端設定符合特定合規標準。
