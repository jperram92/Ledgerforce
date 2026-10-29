---
name: resume
description: Use at the very start of every LedgerForce session (interactive or headless, claude or codex) before doing anything else, and whenever you lose track of where the work stands. Loads the context pack - HANDOVER, state, active task card, open research, recent decisions - from the repository, which is the only memory.
---
# Skill: resume

The repository is the only memory (`AGENTS.md` §0.1). Never rely on chat history.

## Steps

1. Print the context pack:
   ```bash
   bash scripts/agent/resume.sh
   ```
   Read **all** of it. It contains `.agent/HANDOVER.md`, `.agent/state.json`, the active card,
   open research and recent decisions.
2. Check the conductor's view:
   ```bash
   node scripts/agent/conductor.ts status
   ```
3. Confirm the working tree and branch:
   ```bash
   git status --short && git branch --show-current && git log --oneline -5
   ```
   - If `state.json` names a `current_task` and `branch`, you must be on that branch
     (`feat/T-NNNN-<slug>`). If you are not, check it out with `git switch <branch>` (never
     `git reset --hard`, never discard changes; if the tree is dirty, commit it as
     `wip(T-NNNN): recovered uncommitted work` first).
   - If HEAD is ahead of `last_checkpoint`, the extra commits are unverified: run
     `bash scripts/agent/verify.sh --quick` before trusting them.
4. Read, in order: `AGENTS.md` (if not read this session), the active card
   `.agent/backlog/T-NNNN.md` (especially *Steps* and *Notes for the next agent*), and the
   HANDOVER fields *Next action*, *Do not* and *Open questions for human*.
5. Decide the next skill:
   | Situation | Next skill |
   |---|---|
   | No active task (`current_task: null`) | `claim-task` |
   | Active task, lease held by another provider and not expired | stop; run `run-log` and end — do not touch the task |
   | Active task, lease expired or yours | `node scripts/agent/conductor.ts claim T-NNNN --provider <claude\|codex>` to re-take the lease, then continue at *Next action* |
   | Card status `researching` or open RQs | `research` |
   | Card status `in_progress` | `tdd-cycle` at the first unchecked step |
   | Card status `verifying` | `verify` |
   | Card status `review` and you are the other provider | `cross-review` |
   | Card status `blocked` | read the reason; if it needs the human and nothing is answered, pick another task via `claim-task` |
6. Start the run log now (skill `run-log`, step 1) so a crash still leaves a trace.
