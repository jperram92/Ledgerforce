#!/usr/bin/env bash
# Fake provider: finishes building, passes verify, hands the card to cross-review.
[ -n "$FAKE_LOG" ] && echo "fake-to-review ${LF_PROVIDER} ${LF_TASK} argc=$#" >> "$FAKE_LOG"
node "$LF_CONDUCTOR" checkpoint "$LF_TASK" --step "${LF_PROVIDER} verify green" || exit 7
node "$LF_CONDUCTOR" release "$LF_TASK" --status review || exit 8
exit 0
