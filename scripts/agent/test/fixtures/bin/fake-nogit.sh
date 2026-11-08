#!/usr/bin/env bash
# Fake codex in workspace-write mode: may not write .git, so its checkpoints are deferred
# (LF_DEFER_COMMIT=1 from the conductor) and the conductor commits them.
[ -n "$FAKE_LOG" ] && echo "fake-nogit ${LF_PROVIDER} ${LF_TASK} defer=${LF_DEFER_COMMIT:-0}" >> "$FAKE_LOG"
echo one > codex-step1.txt
node "$LF_CONDUCTOR" checkpoint "$LF_TASK" --step "codex step 1 (no .git access)" || exit 7
# wait (max ~8s) until the conductor has committed the deferred checkpoint while we still run
for i in $(seq 1 80); do
  if git log --format=%s | grep -q '^wip(T-0002): codex step 1 (no .git access)$'; then
    echo "fake-nogit ${LF_PROVIDER} ${LF_TASK} saw-commit" >> "$FAKE_LOG"; break
  fi
  sleep 0.1
done
echo final > codex-final.txt
node "$LF_CONDUCTOR" release "$LF_TASK" --status done || exit 8
exit 0
