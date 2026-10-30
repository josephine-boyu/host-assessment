#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/crawler-light-monitor.sh --check <ssh-alias>
  scripts/crawler-light-monitor.sh --apply <ssh-alias>
  scripts/crawler-light-monitor.sh --summary <ssh-alias> [days]
  scripts/crawler-light-monitor.sh --rollback <ssh-alias>

Environment:
  SSH_COMMAND   ssh executable (default: ssh)
  SCP_COMMAND   scp executable (default: scp)
  SSH_CONFIG    optional SSH config path

Apply installs a small Bash sampler that records system and crawler process-tree
metrics every five minutes. Rollback removes the sampler but preserves history.
EOF
}

[[ $# -ge 2 ]] || { usage; exit 2; }
mode=$1
target=$2
[[ "$mode" == "--check" || "$mode" == "--apply" || "$mode" == "--summary" || "$mode" == "--rollback" ]] || { usage; exit 2; }
if [[ "$mode" == "--summary" ]]; then
  [[ $# -le 3 ]] || { usage; exit 2; }
else
  [[ $# -eq 2 ]] || { usage; exit 2; }
fi

ssh_bin=${SSH_COMMAND:-ssh}
scp_bin=${SCP_COMMAND:-scp}
ssh_args=(-o BatchMode=yes -o ConnectTimeout=8)
scp_args=(-q)
if [[ -n "${SSH_CONFIG:-}" ]]; then
  ssh_args=(-F "$SSH_CONFIG" "${ssh_args[@]}")
  scp_args=(-F "$SSH_CONFIG" "${scp_args[@]}")
fi

if [[ "$mode" == "--check" ]]; then
  "$ssh_bin" "${ssh_args[@]}" "$target" 'set -eu; test "$(. /etc/os-release; echo "$ID")" = amzn; command -v bash >/dev/null; command -v sar >/dev/null; systemctl is-active sysstat-collect.timer; sudo -n true; echo "preflight: ok"'
  exit 0
fi

if [[ "$mode" == "--summary" ]]; then
  days=${3:-14}
  [[ "$days" =~ ^[0-9]+$ ]] && ((days >= 1 && days <= 35)) || { echo "days must be 1..35" >&2; exit 2; }
  "$ssh_bin" "${ssh_args[@]}" "$target" "sudo -n awk -F '\t' -v cutoff=\"\$(date -u -d '$days days ago' +%Y-%m-%dT%H:%M:%SZ)\" '\$1 != \"timestamp\" && \$1 >= cutoff { n++; total=\$2; if (min_available == \"\" || \$3 < min_available) min_available=\$3; if (\$4 > max_swap) max_swap=\$4; if (\$5 > max_load) max_load=\$5; if (\$6 > max_disk) max_disk=\$6; if (\$7 > max_count) max_count=\$7; if (\$8 > max_rss_sum) max_rss_sum=\$8; if (\$9 > max_rss_one) max_rss_one=\$9 } END { printf \"samples=%d\\nmem_total_mb=%.1f\\nmem_available_min_mb=%.1f\\nmem_used_peak_percent=%.1f\\nswap_used_max_mb=%.1f\\nload_1m_max=%.2f\\nroot_used_max_percent=%d\\ncrawler_process_count_max=%d\\ncrawler_rss_sum_max_mb=%.1f\\ncrawler_rss_one_max_mb=%.1f\\n\", n, total/1024, min_available/1024, total ? (total-min_available)*100/total : 0, max_swap/1024, max_load, max_disk, max_count, max_rss_sum/1024, max_rss_one/1024 }' /var/lib/ops-toolkit/crawler-history/*.tsv"
  exit 0
fi

if [[ "$mode" == "--rollback" ]]; then
  "$ssh_bin" "${ssh_args[@]}" "$target" 'set -euo pipefail; sudo -n systemctl disable --now ops-toolkit-crawler-monitor.service 2>/dev/null || true; sudo -n rm -f /etc/systemd/system/ops-toolkit-crawler-monitor.service /usr/local/libexec/ops-toolkit-crawler-monitor; sudo -n systemctl daemon-reload; echo "history_preserved=/var/lib/ops-toolkit/crawler-history"'
  exit 0
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/crawler-monitor-sample.sh" "$target:/tmp/ops-toolkit-crawler-monitor"
"$scp_bin" "${scp_args[@]}" "$repo_dir/config/crawler-monitor.service" "$target:/tmp/ops-toolkit-crawler-monitor.service"
"$ssh_bin" "${ssh_args[@]}" "$target" 'set -euo pipefail; sudo -n install -d -o root -g root -m 0755 /usr/local/libexec /var/lib/ops-toolkit/crawler-history; sudo -n install -o root -g root -m 0755 /tmp/ops-toolkit-crawler-monitor /usr/local/libexec/ops-toolkit-crawler-monitor; sudo -n install -o root -g root -m 0644 /tmp/ops-toolkit-crawler-monitor.service /etc/systemd/system/ops-toolkit-crawler-monitor.service; rm -f /tmp/ops-toolkit-crawler-monitor /tmp/ops-toolkit-crawler-monitor.service; sudo -n /usr/local/libexec/ops-toolkit-crawler-monitor --once; sudo -n systemctl daemon-reload; sudo -n systemctl enable --now ops-toolkit-crawler-monitor.service; systemctl is-enabled ops-toolkit-crawler-monitor.service; systemctl is-active ops-toolkit-crawler-monitor.service; ps -C ops-toolkit-crawler-monitor -o rss=,%cpu=,etime= 2>/dev/null | head -n 1 || true; sudo -n tail -n 2 /var/lib/ops-toolkit/crawler-history/$(date -u +%Y-%m-%d).tsv'
