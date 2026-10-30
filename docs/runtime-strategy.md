# 執行環境與 Docker 規劃

本機與主機端實際安裝內容、選用元件與影響，見 [安裝與影響清單](installation-and-impact.md)。本文件的「Docker 延後」指日常工具的容器化；選用的隔離 systemd 驗收已使用 Docker，兩者用途不同。

## 原生執行

管理者端使用 Node.js、Bash 與 SSH，不強制 Docker；Windows 可使用 Git for Windows：

- Node.js、AWS SDK 與 Host Assessment 在管理者電腦執行。
- AWS collector 使用 SDK 預設 credential chain，以 `AWS_PROFILE` 選擇 SSO／named profile／AssumeRole。
- 唯讀 profile 名稱由操作者自訂，例如 `host-assessment-readonly`；credential 僅存在使用者 `.aws` 目錄，不進入 repo。
- SSH collector 暫時使用 host 上的 SSH config、Git SSH 與既有私鑰，不把 credential 複製進容器。
- EC2 不安裝 Node.js；CloudWatch Agent 為選用元件，需另行評估與授權安裝。
- 套件安裝在 repo 的 `node_modules/` 並由 `.gitignore` 排除，版本由 `package-lock.json` 固定。

## 為何 Docker 延後

Docker 適合固定 Node/AWS SDK 版本、CI 與每日排程，但 Windows 的 SSH key ACL、SSH agent forwarding、AWS SSO cache mount 與路徑轉換會增加第一版驗證成本。先確認 AWS collector 的 IAM、資料與報告正確，再處理封裝，可將 credential 問題與 collector 問題分開。

## Docker 里程碑

1. 原生 AWS collector 以 fake client 測試通過。
2. 使用本機 SSO/Profile 完成一次唯讀 AWS 實測。
3. 新增不含 credential 的 `Dockerfile` 與 image build 驗證。
4. 容器只讀掛載 AWS 設定／SSO cache；報告目錄獨立可寫。
5. SSH collector 優先留在 host；若要容器化，使用 SSH agent forwarding 或唯讀 key mount，並另做 Windows 驗證。
6. CI／排程確認 retention、timeout、retry、quota 與 audit log 後才啟用。

## 安全邊界

- image、environment file、volume 與 build log 不包含 access key、private key 或 SSO token。
- collector 只使用 STS identity、EC2 Describe 與 CloudWatch read actions。
- Docker 與原生模式產生相同 schema；分析器不依賴執行環境。
- 主機或雲端變更維持獨立、需人工核准的流程。
