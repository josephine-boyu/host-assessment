#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/cloudwatch-agent-install.sh --check <ssh-alias>
  scripts/cloudwatch-agent-install.sh --apply <ssh-alias>

Environment:
  SSH_COMMAND   ssh executable (default: ssh)
  SCP_COMMAND   scp executable (default: scp)
  SSH_CONFIG    optional SSH config path

The EC2 instance must already have an IAM role that can publish CWAgent metrics.
Fresh installations only. Existing agents/configurations are never overwritten.
EOF
}

[[ $# -eq 2 ]] || { usage; exit 2; }
mode=$1
target=$2
[[ "$mode" == "--check" || "$mode" == "--apply" ]] || { usage; exit 2; }
[[ "$target" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { printf '%s\n' 'Invalid SSH alias' >&2; exit 2; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
config_file="$repo_dir/config/cloudwatch-agent-minimal.json"
ssh_bin=${SSH_COMMAND:-ssh}
scp_bin=${SCP_COMMAND:-scp}
ssh_args=(-o BatchMode=yes -o ConnectTimeout=8)
scp_args=(-q)
if [[ -n "${SSH_CONFIG:-}" ]]; then
  ssh_args=(-F "$SSH_CONFIG" "${ssh_args[@]}")
  scp_args=(-F "$SSH_CONFIG" "${scp_args[@]}")
fi

fresh_guard=$(cat <<'REMOTE'
set -euo pipefail
sudo -n true
if rpm -q amazon-cloudwatch-agent >/dev/null 2>&1 ||
   sudo -n test -e /opt/aws/amazon-cloudwatch-agent ||
   systemctl cat amazon-cloudwatch-agent.service >/dev/null 2>&1; then
  printf '%s\n' 'Refusing existing CloudWatch Agent: preserve its configuration; migrate manually.' >&2
  exit 1
fi
REMOTE
)
check_command="$fresh_guard"$'\n''test "$(. /etc/os-release; echo "$ID")" = amzn; test "$(uname -m)" = x86_64; TOKEN=$(curl -fsS -m 2 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token); ROLE=$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/); test -n "$ROLE"; echo "preflight: ok"'
"$ssh_bin" "${ssh_args[@]}" "$target" "$check_command"

if [[ "$mode" == "--check" ]]; then
  exit 0
fi

remote_tmp=$("$ssh_bin" "${ssh_args[@]}" "$target" 'mktemp -d /tmp/ops-toolkit-cwagent.XXXXXX')
[[ "$remote_tmp" =~ ^/tmp/ops-toolkit-cwagent[.][A-Za-z0-9]+$ ]] || { printf '%s\n' 'Unexpected remote temp path' >&2; exit 1; }
cleanup_remote() { "$ssh_bin" "${ssh_args[@]}" "$target" "rm -rf '$remote_tmp'" >/dev/null 2>&1 || true; }
trap cleanup_remote EXIT
"$scp_bin" "${scp_args[@]}" "$config_file" "$target:$remote_tmp/config.json"
# Recheck after the upload, before downloading/installing anything.
install_command="$fresh_guard"$'\n'"PKG='$remote_tmp/agent.rpm'; CFG='$remote_tmp/config.json'"$'\n''curl -fsSL --retry 3 -o "$PKG" https://amazoncloudwatch-agent.s3.amazonaws.com/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm; sudo -n dnf install -y "$PKG"; sudo -n install -o root -g root -m 0644 "$CFG" /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json; sudo -n /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json; sudo -n systemctl enable amazon-cloudwatch-agent >/dev/null; systemctl is-enabled amazon-cloudwatch-agent; systemctl is-active amazon-cloudwatch-agent'
"$ssh_bin" "${ssh_args[@]}" "$target" "$install_command"
