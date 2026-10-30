# CloudWatch Agent 最小安裝流程

本流程只安裝 metrics collector，不收集 logs、traces 或 process 指標。設定來源為 `config/cloudwatch-agent-minimal.json`：每 60 秒發布 `mem_used_percent`、`swap_used_percent` 與 root `/` 的 `disk_used_percent`，dimension 只使用 `InstanceId`。

## 權限分離

- Host Assessment 本機 IAM user/profile 維持唯讀，只負責查詢 EC2 與 CloudWatch。
- EC2 另外附加 instance role，讓 Agent 發布 `CWAgent` metrics；不要把 Access Key 放入 EC2。
- IAM role 的建立與附加是管理動作，不放進每日唯讀盤點。可由 AWS Console、IaC 或具權限的 AWS CLI bootstrap 流程完成。

AWS 官方 managed policy `CloudWatchAgentServerPolicy` 可作為初始設定。若改用自訂最小政策，需另行驗證 Agent 實際需要的 `cloudwatch:PutMetricData` 與 dimension/tag 相關權限。

## 首次安裝與既有 Agent 保護

腳本僅支援全新安裝。`--check` 與 `--apply` 若偵測到既有 RPM、`/opt/aws/amazon-cloudwatch-agent` 目錄或 systemd service，就會停止；上傳後、安裝前還會再檢查一次。這可避免覆蓋原先的 metrics、logs 或其他監控設定。既有 Agent 的更新、設定合併與回復須另行規劃，不應刪除偵測到的檔案來繞過檢查。請避免多人同時安裝。

安裝暫存檔使用獨立目錄並於結束清理。首次安裝若在套件安裝後失敗，可能留下套件或服務；腳本不自動移除，應先確認狀態再依下方回滾流程處理。本機測試驗證拒絕覆蓋的保護，尚未驗收真實 EC2 上的 RPM 下載、IAM 發布與移除全流程。

先只做 preflight：

```bash
scripts/cloudwatch-agent-install.sh --check example-wp-staging
```

明確套用安裝：

```bash
scripts/cloudwatch-agent-install.sh --apply example-wp-staging
```

Windows Git Bash 若要使用既有 Git SSH，可設定 `SSH_COMMAND`、`SCP_COMMAND` 與 `SSH_CONFIG`。腳本目前明確限制 Amazon Linux x86_64；其他 OS／架構應新增對應 adapter，不要直接套用相同 RPM。

## 驗證與觀察

安裝後確認：

```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status
systemctl is-enabled amazon-cloudwatch-agent
systemctl is-active amazon-cloudwatch-agent
ps -C amazon-cloudwatch-agent -o pid,rss,%cpu,etime,cmd
```

先在 staging 觀察 24～48 小時，包括 Agent RSS/CPU、OOM、應用延遲與 `CWAgent` metric coverage，再決定是否部署 production。成本與負載原則見 `docs/cloudwatch-agent-impact.md`。

### 每台主機的驗收紀錄

- 記錄 OS／架構、Agent 版本、設定驗證結果及 enabled／active 狀態。
- 確認三條指定的 CloudWatch metrics 都有資料點，檢查 log 是否有權限或發布失敗。
- 量測啟動後與穩態 RSS／CPU；小型主機須把 Agent 用量納入記憶體預算，不套用其他主機的數字。
- 安裝當日可能尚無完整 UTC 日，歷史 coverage 不足是預期狀態；確認後續每日摘要逐漸累積。
- 真實日期、機器識別與精確量測結果保存於私人營運紀錄，不放進公開操作指南。

## 回滾

回滾會修改主機，必須另行取得核准。Amazon Linux 可停止、停用並移除套件：

```bash
sudo systemctl disable --now amazon-cloudwatch-agent
sudo dnf remove amazon-cloudwatch-agent
```

確認不再發布後，再依實際用途決定是否解除 EC2 instance role；不要移除仍被其他 Agent 或工作使用的 role。
