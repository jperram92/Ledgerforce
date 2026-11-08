#!/usr/bin/env bash
# Fake provider: the exact message that stopped a real session on 2026-10-24, on stdout (RQ-0002).
[ -n "$FAKE_LOG" ] && echo "fake-session-limit ${LF_PROVIDER} ${LF_TASK} argc=$#" >> "$FAKE_LOG"
echo '{"type":"result","subtype":"success","is_error":true,"result":"You'"'"'ve hit your session limit · resets 7:30am (UTC)"}'
exit 1
