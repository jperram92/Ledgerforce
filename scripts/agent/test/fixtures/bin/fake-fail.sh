#!/usr/bin/env bash
# Fake provider: crashes with a non-quota error.
[ -n "$FAKE_LOG" ] && echo "fake-fail ${LF_PROVIDER} ${LF_TASK} argc=$#" >> "$FAKE_LOG"
echo "TypeError: cannot read properties of undefined" >&2
exit 2
