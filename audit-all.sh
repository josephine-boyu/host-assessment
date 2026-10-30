#!/usr/bin/env bash
# 依 TSV 主機清單逐台執行唯讀健檢，並保留個別報告與批次摘要。

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
  shift
fi
HOSTS_FILE="${1:-$SCRIPT_DIR/config/hosts.tsv}"
REPORT_ROOT="${REPORT_DIR:-$SCRIPT_DIR/reports}"
RUN_ID=$(date '+%Y%m%d-%H%M%S')
RUN_DIR="$REPORT_ROOT/$RUN_ID"
SUMMARY_FILE="$RUN_DIR/summary.tsv"

usage() {
  cat <<'USAGE'
用法: ./audit-all.sh [--check] [hosts.tsv]

TSV 欄位: project<TAB>environment<TAB>ssh_target<TAB>audit_script
空白行及 # 開頭的註解會略過。報告預設寫入 reports/<時間戳>/。
可用 REPORT_DIR 環境變數改變輸出根目錄。
--check 只驗證設定並列出目標，不會建立報告或連線主機。
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$HOSTS_FILE" ]]; then
  printf '找不到主機清單: %s\n請先複製 config/hosts.example.tsv 為 config/hosts.tsv。\n' "$HOSTS_FILE" >&2
  exit 2
fi

if [[ "$CHECK_ONLY" -eq 0 ]]; then
  mkdir -p "$RUN_DIR"
  printf 'project\tenvironment\tssh_target\tstatus\trisk_count\treport\n' >"$SUMMARY_FILE"
fi

total=0
succeeded=0
failed=0

while IFS=$'\t' read -r project environment ssh_target audit_script extra ||
  [[ -n "${project}${environment}${ssh_target}${audit_script}${extra}" ]]; do
  project=${project%$'\r'}
  environment=${environment%$'\r'}
  ssh_target=${ssh_target%$'\r'}
  audit_script=${audit_script%$'\r'}

  [[ -z "$project" || "$project" == \#* ]] && continue

  if [[ -n "${extra:-}" || -z "$environment" || -z "$ssh_target" || -z "$audit_script" ]]; then
    printf '格式錯誤，必須剛好有四欄: project, environment, ssh_target, audit_script\n' >&2
    exit 2
  fi
  if [[ ! "$project" =~ ^[A-Za-z0-9._-]+$ || ! "$environment" =~ ^[A-Za-z0-9._-]+$ ]]; then
    printf 'project/environment 只能包含英數、點、底線、連字號: %s / %s\n' "$project" "$environment" >&2
    exit 2
  fi
  if [[ "$audit_script" == */* || ! -f "$SCRIPT_DIR/$audit_script" ]]; then
    printf '找不到或不允許清單指定的腳本: %s\n' "$audit_script" >&2
    exit 2
  fi

  total=$((total + 1))
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    printf '[%d] %s (%s) via %s，腳本 %s\n' \
      "$total" "$project" "$environment" "$ssh_target" "$audit_script"
    continue
  fi
  report_name="${project}-${environment}.md"
  report_path="$RUN_DIR/$report_name"
  printf '[%d] 盤點 %s (%s) via %s ...\n' "$total" "$project" "$environment" "$ssh_target"

  if "$SCRIPT_DIR/$audit_script" "$ssh_target" >"$report_path" 2>&1; then
    status=ok
    succeeded=$((succeeded + 1))
  else
    status=failed
    failed=$((failed + 1))
  fi
  risk_count=$(grep -Ec '^### (Critical|Warning)：' "$report_path" || true)
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$project" "$environment" "$ssh_target" "$status" "$risk_count" "$report_name" >>"$SUMMARY_FILE"
  printf '    %s，風險 %s 項: %s\n' "$status" "$risk_count" "$report_path"
done <"$HOSTS_FILE"

if [[ "$total" -eq 0 ]]; then
  printf '主機清單沒有可執行的資料列。\n' >&2
  exit 2
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  printf '\n設定有效：共 %d 台；未連線任何主機。\n' "$total"
  exit 0
fi

printf '\n完成：共 %d 台，成功 %d，失敗 %d。摘要：%s\n' \
  "$total" "$succeeded" "$failed" "$SUMMARY_FILE"

[[ "$failed" -eq 0 ]]
