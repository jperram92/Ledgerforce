#!/usr/bin/env bash
# Fake provider: decides the task needs the human and marks it blocked.
[ -n "$FAKE_LOG" ] && echo "fake-blocked ${LF_PROVIDER} ${LF_TASK} argc=$#" >> "$FAKE_LOG"
node "$LF_CONDUCTOR" release "$LF_TASK" --status blocked --reason "needs golden posting approval" || exit 8
exit 0
