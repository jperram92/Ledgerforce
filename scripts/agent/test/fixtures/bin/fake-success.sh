#!/usr/bin/env bash
# Fake provider: checkpoints a step and finishes the task.
[ -n "$FAKE_LOG" ] && echo "fake-success ${LF_PROVIDER} ${LF_TASK} argc=$#" >> "$FAKE_LOG"
echo "done by ${LF_PROVIDER}" > "work-${LF_PROVIDER}-done.txt"
node "$LF_CONDUCTOR" checkpoint "$LF_TASK" --step "${LF_PROVIDER} finished step 2" || exit 7
node "$LF_CONDUCTOR" release "$LF_TASK" --status done || exit 8
echo '{"type":"result","is_error":false,"total_cost_usd":1.25}'
exit 0
