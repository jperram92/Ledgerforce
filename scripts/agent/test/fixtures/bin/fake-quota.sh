#!/usr/bin/env bash
# Fake provider: does some uncommitted work, then dies with a credit/quota error.
[ -n "$FAKE_LOG" ] && echo "fake-quota ${LF_PROVIDER} ${LF_TASK} argc=$#" >> "$FAKE_LOG"
echo "partial work by ${LF_PROVIDER}" > "work-${LF_PROVIDER}.txt"
echo "working on ${LF_TASK}..."
echo "Error: Credit balance is too low to access the API" >&2
exit 1
