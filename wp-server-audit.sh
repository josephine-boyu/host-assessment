#!/usr/bin/env bash
# 相容入口：所有資料統一由 Node JSON collector 收集，再產生 Markdown 分析報告。
# 遠端操作維持唯讀；不會修改主機或雲端資源。

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TARGET="${1:?用法: $0 <user@host> [ssh_key_path] [ssh_port]}"
KEY="${2:-}"
PORT="${3:-}"

if ! command -v node >/dev/null 2>&1; then
  printf '需要 Node.js 20 以上才能執行collector。\n' >&2
  exit 127
fi

if [[ -n "$KEY" ]]; then export SSH_IDENTITY_FILE="$KEY"; fi
if [[ -n "$PORT" ]]; then export SSH_PORT="$PORT"; fi

exec node "$SCRIPT_DIR/bin/ops-audit.mjs" report "$TARGET"
