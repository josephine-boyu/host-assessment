# 公開版發布指南

本指南供維護者建立可分享的發行內容。每次發布須檢查最終檔案與將推送的 Git 歷史；不要將含有營運資訊的工作目錄直接整包上傳。

品質要求見 [發布品質檢核表](public-release-priorities.md)，安裝驗收範圍見 [systemd 驗收](monitor-lifecycle-validation.md)。公開內容依工具、[分析 SOP](sop/rightsizing-analysis.md)、[匿名案例](case-studies/wordpress-rightsizing.md) 三層組織；案例不能代替通用決策流程。

## 可公開範圍

- `bin/`、`src/`、`scripts/`、通用 `config/*.example.*` 與監控模板；
- 單元測試、匿名 fixtures、架構及操作文件；
- 已去識別化的 JSON／Markdown 範例報告；
- least-privilege IAM 範例與安全／回滾原則。

## 不可公開

- `.env`、`config/*.local.*`、`config/hosts.tsv`、SSH config 與私鑰；
- `reports/`、真實 access log、錯誤 log 與事件檔；
- IP、hostname、帳號、AWS account／instance／volume ID；
- 客戶、訂單、email、網站路徑或可識別專案名稱；
- 包含上述資料的舊 commit、tag、stash、reflog 或 patch。

## 發布流程

1. 在來源 repo 完成測試與敏感資料掃描，保留掃描結果但不要把秘密本身寫入報告。
2. 執行 `node scripts/export-public-copy.mjs <new-empty-directory>` 建立 allowlist 公開副本；目的地必須不存在，工具不會覆蓋舊目錄，也不會複製 `.git`、`STATUS.md`、`reports/`、local config 或私人排程清冊。
3. 再次掃描乾淨副本的內容、檔名與 Git staged diff。
4. 執行 `npm ci`、`npm test`，並對所有 shell scripts 執行 `bash -n`；有 ShellCheck 時再執行 ShellCheck。
5. 人工檢閱 README、範例報告、IAM policy、LICENSE 與 SECURITY。
6. 檢閱 staged diff 後建立發布 commit；首次公開時使用不含私人歷史的新 Git repo。推送後確認 CI 成功及漏洞通報管道可用。

匯出器會將可執行來源與 shebang launcher 設為安全的 `0755`，一般檔案為 `0644`。Windows 的檔案權限不能可靠表示 Git executable bit；若在 Windows 建立公開 Git repo，完成 `git add` 後須在 Git Bash 明確設定索引權限，再檢閱 staged diff：

```bash
git ls-files -z '*.sh' 'bin/ops-audit.mjs' | git update-index --chmod=+x -z --stdin
```

請在準備發布的 repo 內執行並檢閱索引權限。POSIX 回歸測試會直接啟動匯出後的 shell 與 Node launcher，不只以 `bash`／`node` 間接執行。

匯出使用 `config/public-files.json` 的逐檔清單，新檔不會自動包含。公開 `AGENTS.md` 來自 `docs/public-AGENTS.md`，不複製私人協作規範。所有列入檔案（含匯出器）均掃描，拒絕 symlink／junction、巢狀 `.env`、私鑰與路徑穿越；掃描完成後才建立副本。

可在不追蹤的 `config/public-export.local.json` 設定 `{"forbidden_terms":["private-project-name","private-person-name"]}`，加入自己的識別字串。工具不輸出命中的內容；內建規則不等於完整 secret scanner，仍須使用 Gitleaks 等獨立工具並人工檢閱匿名化。

CI 僅做離線測試、shell syntax、乾淨匯出、安裝與示範，不帶 AWS／SSH credentials；每次發布須確認平台上的執行結果。另有明確 opt-in 的 `scripts/validate-monitor-lifecycle.mjs --run`，在拋棄式容器內驗證真正的 systemd 安裝／回滾流程；它不隨一般測試啟動，也不代表已驗證 EC2 IAM、SSH 或 SELinux enforcing。

## 發布前檢查

- [ ] `git status --short` 只包含預期檔案。
- [ ] `git ls-files` 沒有 reports、local config、私鑰或憑證。
- [ ] 目前內容與完整歷史均未命中 secret scanner。
- [ ] 範例只使用 `example-*`、RFC 5737 測試 IP 或明確的假 ID。
- [ ] 完整測試、shell syntax 與 `git diff --check` 通過。
- [ ] logrotate、systemd、IAM 與 rollback 文件和實作一致。
- [ ] 公開 repo 的 vulnerability reporting 已啟用。

## 匿名化原則

匿名化不是只替換密碼。時間、region、機型、流量與錯誤組合也可能辨識客戶；公開案例應聚合、四捨五入或改用合成數據，並清楚標示為示範資料。
