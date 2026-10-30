#!/usr/bin/env bash
set -euo pipefail
[[ ${OPS_TOOLKIT_CONTAINER_TEST:-} == 1 ]] || { echo 'Run only in the disposable test container.' >&2; exit 2; }
mkdir -p /var/log/httpd
mkdir -p /var/lib/ops-toolkit/http-history /usr/local/libexec
install -m 0755 /repo/config/http-metrics-rotation.sh /usr/local/libexec/ops-toolkit-http-metrics-rotation
cp /usr/local/apache2/conf/httpd.conf /tmp/httpd.original
cp /repo/config/http-metrics-httpd.conf /tmp/metrics.conf
sed -i 's@/usr/sbin/rotatelogs@/usr/local/apache2/bin/rotatelogs@g' /tmp/metrics.conf
printf '\nInclude /tmp/metrics.conf\n' >> /usr/local/apache2/conf/httpd.conf
cp /repo/config/http-metrics-logrotate.conf /tmp/metrics.rotate
chmod 0644 /tmp/metrics.rotate
cat > /tmp/logrotate.conf <<'EOF'
/var/log/httpd/*log {
  daily
  rotate 2
  missingok
  copytruncate
}
include /tmp/metrics.rotate
EOF
printf 'old log\n' > /var/log/httpd/ops-toolkit-request-metrics.log
httpd -t
logrotate --debug /tmp/logrotate.conf
httpd -k start
curl --fail --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1/ >/dev/null
test -s /var/log/httpd/ops-toolkit-request-metrics.metrics
logrotate --force --state /tmp/logrotate.state /tmp/logrotate.conf
curl --fail http://127.0.0.1/ >/dev/null
test -s /var/log/httpd/ops-toolkit-request-metrics.metrics
test -f /var/log/httpd/ops-toolkit-request-metrics.ring
test -s "/var/lib/ops-toolkit/http-history/$(date -u +%F).gaps"
awk 'NF != 3 {exit 1} $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/ {exit 1}' /var/log/httpd/ops-toolkit-request-metrics.metrics
cp /tmp/httpd.original /usr/local/apache2/conf/httpd.conf
httpd -t
httpd -k graceful
curl --fail http://127.0.0.1/ >/dev/null
httpd -k stop
echo 'PASS: GlobalLog, generic rotation coexistence, forced rotation, continued writes, config restore'
