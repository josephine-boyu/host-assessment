#!/usr/bin/env bash
set -euo pipefail
[[ ${OPS_TOOLKIT_CONTAINER_TEST:-} == 1 && -f /.dockerenv && $(cat /proc/1/comm) == systemd ]] || {
  echo 'Requires the disposable systemd test container.' >&2; exit 2;
}
cd /opt/ops-toolkit
export SSH_COMMAND=$PWD/test/integration/local-ssh.sh SCP_COMMAND=$PWD/test/integration/local-scp.sh
unset SSH_CONFIG
mkdir -p /tmp/lifecycle-results
trap 'echo "FAIL at line $LINENO" >&2; systemctl --failed --no-pager; journalctl -n 40 --no-pager' ERR
run() { local script=$1 mode=$2; shift 2; bash "scripts/$script-monitor.sh" "$mode" lifecycle-local "$@"; }
healthy() { systemctl is-active --quiet httpd php-fpm; curl -fsS http://127.0.0.1/ | grep -q ok; }
backup() { sed -n 's/^backup=//p' "$1" | tail -1; }
failed() { if "$@"; then echo 'Expected failure but command succeeded' >&2; exit 1; fi; }
wait_services() { for ((i=0;i<30;i++)); do if healthy 2>/dev/null; then return; fi; sleep 1; done; return 1; }
timer_fires() {
  local service=$1 before timer
  timer=${service%.service}.timer
  before=$(systemctl show "$timer" -p LastTriggerUSecMonotonic --value)
  for ((i=0;i<165;i++)); do
    sleep 1
    if [[ $(systemctl show "$timer" -p LastTriggerUSecMonotonic --value) != "$before" ]]; then
      # Let the triggered oneshot complete, then require successful sampling.
      for ((j=0;j<15;j++)); do
        [[ $(systemctl show "$service" -p ActiveState --value) != activating ]] && break
        sleep 1
      done
      [[ $(systemctl show "$service" -p Result --value) == success ]]
      systemctl is-active --quiet "${service%.service}.timer"
      echo "PASS: timer automatically triggered $service"
      return
    fi
  done
  echo "Timer did not trigger $service" >&2; return 1
}
wait_services
cp -p /etc/php-fpm.d/www.conf /tmp/original-www.conf
run php-fpm --check
run http-metrics --check
run php-fpm --apply | tee /tmp/lifecycle-results/php-apply.log
php_backup=$(backup /tmp/lifecycle-results/php-apply.log)
test -n "$php_backup"
systemctl is-enabled --quiet ops-toolkit-php-fpm-monitor.timer
systemctl is-active --quiet ops-toolkit-php-fpm-monitor.timer
curl -fsS 'http://127.0.0.1:9081/ops-toolkit-fpm-status?json' | jq -e 'has("active processes")' >/dev/null
ss -ltnH 'sport = :9081' | awk '$4 != "127.0.0.1:9081" {exit 1}'
test -s "/var/lib/ops-toolkit/php-fpm-history/$(date -u +%F).tsv"
timer_fires ops-toolkit-php-fpm-monitor.service
failed run php-fpm --apply
run php-fpm --rollback "$php_backup"
cmp /tmp/original-www.conf /etc/php-fpm.d/www.conf
test ! -e /etc/systemd/system/ops-toolkit-php-fpm-monitor.timer
test ! -e /etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf
test -s "/var/lib/ops-toolkit/php-fpm-history/$(date -u +%F).tsv"
healthy
echo 'PASS: PHP install, duplicate rejection, brief status, manual rollback, history preserved'

# Invalid Apache configuration must restore the pool and remove managed files.
cp config/php-fpm-monitor-httpd.conf /tmp/php-httpd-good
printf '\nInvalidLifecycleDirective on\n' >> config/php-fpm-monitor-httpd.conf
sleep 1
failed run php-fpm --apply
cp /tmp/php-httpd-good config/php-fpm-monitor-httpd.conf
cmp /tmp/original-www.conf /etc/php-fpm.d/www.conf
test ! -e /etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf
test ! -e /usr/local/libexec/ops-toolkit-php-fpm-monitor
healthy
echo 'PASS: PHP invalid-config automatic rollback'

cp config/php-fpm-monitor-sample.sh /tmp/php-sample-good
printf '#!/usr/bin/env bash\nexit 42\n' > config/php-fpm-monitor-sample.sh
sleep 1
failed run php-fpm --apply
cp /tmp/php-sample-good config/php-fpm-monitor-sample.sh
cmp /tmp/original-www.conf /etc/php-fpm.d/www.conf
test ! -e /etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf
test ! -e /usr/local/libexec/ops-toolkit-php-fpm-monitor
healthy
echo 'PASS: PHP service-start failure automatic rollback'

# Exercise both monitors together; PHP's dedicated VHost must never count as
# website traffic, including requests with misleading Host headers.
sleep 1
run php-fpm --apply | tee /tmp/lifecycle-results/php-combined.log
cp /etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf /tmp/status-with-marker
sed -i '/SetEnv ops_toolkit_internal_monitor/d' /etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf
failed run http-metrics --check > /tmp/legacy-preflight.log 2>&1
grep 'Incompatible PHP status VirtualHost' /tmp/legacy-preflight.log
cp /tmp/status-with-marker /etc/httpd/conf.d/ops-toolkit-php-fpm-status.conf
run http-metrics --apply | tee /tmp/lifecycle-results/http-apply.log
http_backup=$(backup /tmp/lifecycle-results/http-apply.log)
test -n "$http_backup"
failed run http-metrics --apply
healthy
sleep 1
before_requests=$(wc -l < /var/log/httpd/ops-toolkit-request-metrics.metrics)
for attempt in {1..10}; do curl -fsS -H 'Host: localhost:80' 'http://127.0.0.1:9081/ops-toolkit-fpm-status?json' >/dev/null; done
curl -fsS -H 'Host: localhost:9081' http://127.0.0.1/ >/dev/null
curl -fsS http://127.0.0.1/ >/dev/null
for attempt in {1..30}; do
  after_requests=$(wc -l < /var/log/httpd/ops-toolkit-request-metrics.metrics)
  ((after_requests >= before_requests+2)) && break
  sleep 0.1
done
test "$after_requests" -eq "$((before_requests+2))"
echo 'PASS: internal PHP probes excluded; normal and misleading-Host website requests counted'
curl -fsS http://127.0.0.1/ >/dev/null
systemctl start ops-toolkit-http-metrics-monitor.service
test -s "/var/lib/ops-toolkit/http-history/$(date -u +%F).tsv"
logrotate --debug /etc/logrotate.conf
logrotate --force --state /tmp/lifecycle-logrotate.state /etc/logrotate.conf
bash test/integration/http-ring-bounds.sh
curl -fsS http://127.0.0.1/ >/dev/null
for attempt in {1..20}; do test -s /var/log/httpd/ops-toolkit-request-metrics.metrics && break; sleep 0.1; done
test -s /var/log/httpd/ops-toolkit-request-metrics.metrics
test -f /var/log/httpd/ops-toolkit-request-metrics.ring
test -f /var/log/httpd/ops-toolkit-request-metrics.ring.1
test -s "/var/lib/ops-toolkit/http-history/$(date -u +%F).gaps"
awk 'NF != 3 || $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/ {exit 1}' /var/log/httpd/ops-toolkit-request-metrics.metrics
sleep 1
run http-metrics --update | tee /tmp/lifecycle-results/http-update.log
update_backup=$(backup /tmp/lifecycle-results/http-update.log)
test "$http_backup" != "$update_backup"
run http-metrics --rollback "$update_backup"
systemctl is-enabled --quiet ops-toolkit-http-metrics-monitor.timer
systemctl is-active --quiet ops-toolkit-http-metrics-monitor.timer
cmp "$update_backup/sample.sh" /usr/local/libexec/ops-toolkit-http-metrics-monitor
cmp "$update_backup/rotation.sh" /usr/local/libexec/ops-toolkit-http-metrics-rotation
cmp "$update_backup/producer-version" /var/lib/ops-toolkit/http-history/producer-version
cmp "$update_backup/valid-since" /var/lib/ops-toolkit/http-history/valid-since
healthy
echo 'PASS: HTTP install, update, update rollback, rotation coexistence and continued writes'
timer_fires ops-toolkit-http-metrics-monitor.service

# Trigger a real systemd oneshot failure after files have been installed.
cp config/http-metrics-sample.sh /tmp/http-sample-good
printf '#!/usr/bin/env bash\nexit 42\n' > config/http-metrics-sample.sh
sleep 1
failed run http-metrics --update
cp /tmp/http-sample-good config/http-metrics-sample.sh
cmp /tmp/http-sample-good /usr/local/libexec/ops-toolkit-http-metrics-monitor
systemctl is-enabled --quiet ops-toolkit-http-metrics-monitor.timer
systemctl is-active --quiet ops-toolkit-http-metrics-monitor.timer
systemctl start ops-toolkit-http-metrics-monitor.service
healthy
echo 'PASS: HTTP service-start failure automatic rollback'

# A partial backup must not be treated as a complete restore point.
managed=(/etc/httpd/conf.d/ops-toolkit-request-metrics.conf /etc/logrotate.d/ops-toolkit-request-metrics /usr/local/libexec/ops-toolkit-http-metrics-monitor /etc/systemd/system/ops-toolkit-http-metrics-monitor.service /etc/systemd/system/ops-toolkit-http-metrics-monitor.timer /var/lib/ops-toolkit/http-history/valid-since)
sha256sum "${managed[@]}" > /tmp/lifecycle-before-backup-failure
sleep 1
failed env LIFECYCLE_FAIL_BACKUP=1 bash scripts/http-metrics-monitor.sh --update lifecycle-local > /tmp/backup-failure.log 2>&1
grep 'Injected backup-copy failure' /tmp/backup-failure.log
incomplete=$(find /var/backups/ops-toolkit/http-metrics -name backup.incomplete | head -1)
test -n "$incomplete"
failed run http-metrics --rollback "${incomplete%/backup.incomplete}"
sha256sum "${managed[@]}" > /tmp/lifecycle-after-backup-failure
cmp /tmp/lifecycle-before-backup-failure /tmp/lifecycle-after-backup-failure
systemctl is-active --quiet ops-toolkit-http-metrics-monitor.timer
systemctl is-enabled --quiet ops-toolkit-http-metrics-monitor.timer
healthy
echo 'PASS: incomplete backup leaves live files and timer unchanged'

# Enabled does not mean active: rollback must preserve a deliberately stopped timer.
systemctl stop ops-toolkit-http-metrics-monitor.timer
sleep 1
run http-metrics --update | tee /tmp/lifecycle-results/http-stopped-update.log
run http-metrics --rollback "$(backup /tmp/lifecycle-results/http-stopped-update.log)"
systemctl is-enabled --quiet ops-toolkit-http-metrics-monitor.timer
if systemctl is-active --quiet ops-toolkit-http-metrics-monitor.timer; then
  echo 'Rollback unexpectedly started a previously stopped timer' >&2; exit 1
fi
echo 'PASS: rollback preserves enabled but inactive timer'

run http-metrics --rollback "$http_backup"
test ! -e /etc/httpd/conf.d/ops-toolkit-request-metrics.conf
test ! -e /etc/logrotate.d/ops-toolkit-request-metrics
test ! -e /etc/systemd/system/ops-toolkit-http-metrics-monitor.timer
test ! -e /usr/local/libexec/ops-toolkit-http-metrics-monitor
test ! -e /var/lib/ops-toolkit/http-history/producer-version
test ! -e /usr/local/libexec/ops-toolkit-http-metrics-rotation
test -s "/var/lib/ops-toolkit/http-history/$(date -u +%F).tsv"
apachectl configtest
logrotate --debug /etc/logrotate.conf
healthy
echo 'PASS: HTTP initial-install rollback and history preserved'
run php-fpm --rollback "$(backup /tmp/lifecycle-results/php-combined.log)"
echo 'PASS: all monitor lifecycle scenarios'
