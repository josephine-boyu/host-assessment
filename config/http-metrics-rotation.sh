#!/usr/bin/env bash
set -euo pipefail
umask 0027
# Called by Apache rotatelogs at startup/rotation. Never read request content.
# Conservatively invalidate evidence crossing a rotation, including restarts.
history_dir=/var/lib/ops-toolkit/http-history
date -u +%Y-%m-%dT%H:%M:%SZ >> "$history_dir/$(date -u +%Y-%m-%d).gaps"
