#!/usr/bin/env bash
set -euo pipefail
[[ ${OPS_TOOLKIT_CONTAINER_TEST:-} == 1 && -f /.dockerenv ]] || exit 2
while [[ ${1:-} == -* ]]; do shift 2; done
[[ ${1:-} == lifecycle-local ]] || exit 2
shift
if [[ ${LIFECYCLE_FAIL_BACKUP:-} == 1 ]]; then
  # Bind the fault inside the remote shell; login/startup PATH changes must not
  # silently bypass the test double.
  exec bash -c 'sudo() { LIFECYCLE_FAIL_BACKUP=1 bash /opt/ops-toolkit/test/integration/failing-sudo.sh "$@"; }; '"$1"
fi
exec bash -c "$1"
