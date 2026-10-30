#!/usr/bin/env bash
set -euo pipefail
[[ ${OPS_TOOLKIT_CONTAINER_TEST:-} == 1 && -f /.dockerenv ]] || exit 2
[[ ${1:-} == -q ]] && shift
[[ $2 == lifecycle-local:/tmp/ops-toolkit-* ]] || exit 2
cp -- "$1" "${2#lifecycle-local:}"
