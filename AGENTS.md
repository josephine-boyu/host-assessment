# Host Assessment 協作規範

開始工作先閱讀 README.md 的適用範圍、快速開始與操作影響。

- 執行真實主機盤點或選用安裝前，閱讀 docs/installation-and-impact.md；多專案與 AWS 命令查 docs/command-guide.md，排程查 docs/windows-scheduler.md。
- 評估指定目標或提出規格建議時，閱讀 docs/sop/rightsizing-analysis.md；重算指定期間時另讀 docs/window-recompute.md。
- 公開範圍與發布驗收依 docs/public-release.md。修改首次使用文件後，驗證範例命令與相對連結，支援聲明須符合已記錄的驗收範圍。

- 盤點與變更分開。遠端連線須有使用者指定的目標與授權；事前說明腳本、目的及輸出位置。變更主機、發布與 commit 須有明確授權。
- 私鑰留在 SSH／憑證管理服務；本機設定與 reports 不提交。診斷只輸出必要數值，不輸出密碼、token、私鑰或完整環境變數。
- 保留既有未提交變更。腳本 .sh 使用 LF；修改後執行 bash -n，有 ShellCheck 時一併檢查。
- 完成前檢閱 diff、執行相關測試、檢查 Git 狀態與敏感檔案；回報已驗證範圍與未完成事項。
- 新增可公開檔案時更新 config/public-files.json；匯出採逐檔清單，不會自動包含新檔。
