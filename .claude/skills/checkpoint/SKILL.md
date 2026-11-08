---
name: checkpoint
description: Use after every green step of a LedgerForce task (and at least every 10 minutes of work, the heartbeat) to commit work-in-progress, renew the lease, update the task card, state.json and HANDOVER.md so a dead session loses minutes, not hours.
---
# Skill: checkpoint

Heartbeat rule: `.agent/config.yaml` → `heartbeat_minutes: 10`, `lease_minutes: 45`. Checkpoint
after every green step and never let more than 10 minutes pass without one while you hold a
lease. If you are mid-change and not green when the heartbeat is due, finish to green quickly or
run the `handover` skill — never checkpoint a red state as green.

## Steps

1. Make sure the step is green:
   ```bash
   bash scripts/agent/verify.sh --quick
   ```
   If it fails, do not checkpoint; fix (skill `tdd-cycle`) or hand over.
2. Update the card `.agent/backlog/T-NNNN.md`: tick finished steps (`- [x]`), add any new steps
   you discovered, and refresh *Notes for the next agent* (what is true now, what's next,
   gotchas, commands to run).
3. Run the conductor checkpoint (commits all changes as
   `wip(T-NNNN): step k/n — <text>`, renews the lease, updates the card's `last_checkpoint`,
   `.agent/state.json` and the HANDOVER skeleton):
   ```bash
   node scripts/agent/conductor.ts checkpoint T-NNNN --step "k/n — <what is now green>"
   ```
   `k/n` = steps done / total steps in the card. Keep the text under 72 characters.
4. Fill the narrative fields of `.agent/HANDOVER.md` if they are stale (*Done*,
   *In progress*, *Next action*, *Decisions taken*, *Open questions for human*, *Do not*). Never
   amend or rewrite commits; if you changed it, make a follow-up commit:
   `git commit -am "wip(T-NNNN): step k/n — handover notes"`.
5. Append one line to the run log (skill `run-log`): time, step, commit sha
   (`git rev-parse --short HEAD`).
6. If the conductor reports the lease was lost (another provider took over), stop immediately:
   do not commit further; run skill `run-log` and end the session.
