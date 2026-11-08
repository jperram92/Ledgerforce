#!/usr/bin/env bash
# Fake provider: never heartbeats (hangs past its lease).
[ -n "$FAKE_LOG" ] && echo "fake-hang ${LF_PROVIDER} ${LF_TASK} argc=$#" >> "$FAKE_LOG"
sleep 30
exit 0
