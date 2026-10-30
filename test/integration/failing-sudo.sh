#!/usr/bin/env bash
set -euo pipefail
[[ ${OPS_TOOLKIT_CONTAINER_TEST:-} == 1 && -f /.dockerenv ]] || exit 2
if [[ ${LIFECYCLE_FAIL_BACKUP:-} == 1 && "$*" == *'cp -p /etc/systemd/system/ops-toolkit-http-metrics-monitor.service '* ]]; then
  echo 'Injected backup-copy failure' >&2
  exit 73
fi
exec /usr/bin/sudo "$@"
