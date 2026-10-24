---
name: verify
description: Use when all acceptance criteria of a LedgerForce task are green, before setting the card to verifying/review, and whenever you need to prove the definition of done. Runs scripts/agent/verify.sh (all design §10.8 gates) and records the result.
---
# Skill: verify

Gates and their meaning: `Docs/process/definition-of-done.md`.

## Steps

1. Set card `status: verifying` and checkpoint:
   ```bash
   node scripts/agent/conductor.ts checkpoint T-NNNN --step "n/n — all criteria green, verifying"
   ```
2. Run the full gate suite and keep the output:
   ```bash
   LOG=$(mktemp); bash scripts/agent/verify.sh 2>&1 | tee "$LOG"; echo "exit=${PIPESTATUS[0]}"
   ```
   (`--quick` is only for inner TDD loops; it never counts for this step.)
3. If any gate fails: copy the failing gate name and first error into the card's
   *Notes for the next agent*, add a step to fix it, set `status: in_progress`, go back to skill
   `tdd-cycle`. Do **not** weaken the gate.
4. If you need to see a gate individually: `pnpm typecheck`, `pnpm lint`, `pnpm test`,
   `pnpm test:db`, `pnpm test:e2e`.
5. When green: paste the summary table (gate → result) into the run log, then:
   - UI or report changes, or any card with `success_scenarios:` → skill `evidence`;
   - then set card `status: review`, checkpoint
     (`--step "n/n — verify green, ready for cross-review"`), and run skill `handover` with reason
     `ready for cross-review by <other provider>` so the conductor dispatches skill
     `cross-review` to the other provider.
