#!/usr/bin/env bash
set -euo pipefail
[[ ${OPS_TOOLKIT_CONTAINER_TEST:-} == 1 ]] || { echo 'Run only in the disposable test container.' >&2; exit 2; }
directory=$(mktemp -d /tmp/ops-toolkit-ring-test.XXXXXX)
trap 'rm -rf "$directory"' EXIT
# More than three rotations, independent of timer/logrotate scheduling.
awk 'BEGIN { for(i=0;i<1600000;i++) print "1760000000 200 123456" }' |
  /usr/sbin/rotatelogs -f -n 2 -L "$directory/current" "$directory/ring" 10M
test "$(find "$directory" -maxdepth 1 -type f -name 'ring*' | wc -l)" -eq 2
total=0
for file in "$directory/ring" "$directory/ring.1"; do
  bytes=$(stat -c %s "$file")
  ((bytes <= 10485760 + 65536))
  total=$((total + bytes))
done
((total <= 20971520 + 131072))
[[ "$directory/current" -ef "$directory/ring" || "$directory/current" -ef "$directory/ring.1" ]]
printf 'PASS: native circular log bounded to two 10 MiB files plus write-buffer overshoot (%s bytes retained)\n' "$total"
