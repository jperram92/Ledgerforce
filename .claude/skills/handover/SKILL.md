---
name: handover
description: Use BEFORE stopping a LedgerForce session for any reason - credit, quota, usage or rate-limit error, context nearly full, budget reached, task blocked, step finished for another role, or end of work. Safe to run when nearly out of credits - the shortest path (one conductor command) comes first, narrative fields after.
---
# Skill: handover

Order matters: do the cheapest, most valuable thing first. If you are cut off after step 1, the
conductor still has what it needs; after step 2, the next provider has everything.

## Step 1 — one command (do this first, always)

```bash
node scripts/agent/conductor.ts handover --reason "<why you are stopping, e.g. credit limit reached>"
```
It writes the `.agent/HANDOVER.md` skeleton from `.agent/state.json` (task, branch, last green
commit, step). **Then**, only if your work since the last checkpoint is green and you still
have budget, save it: `node scripts/agent/conductor.ts checkpoint T-NNNN --step "k/n — <text>"`.
If it is not green, do **not** checkpoint — the conductor stashes uncommitted work into a `wip/`
commit and the next provider resumes from `last_checkpoint`.

## Step 2 — fill the narrative fields (2–6 short lines each, facts only)

Edit `.agent/HANDOVER.md` (design §10.5 template):
- **From:** `<claude|codex> (run rNN)`  **Reason:** same as step 1
- **Done:** steps completed, with what proves them (test names).
- **In progress:** the exact state, incl. failing tests as `path: message`.
- **Next action:** the single next command or edit the next agent should do.
- **Decisions taken:** DL/ADR ids, or `none new`.
- **Open questions for human:** only human-gate items (`Docs/process/human-gates.md`), each
  with the gate name; otherwise `none`.
- **Do not:** traps, e.g. "change golden files in Docs/accounting/", "re-run migration 0007 by
  hand".

Commit: `git add .agent/HANDOVER.md && git commit -m "wip(T-NNNN): handover — <reason>"`.

## Step 3 — card and lease

- Update the card's *Notes for the next agent* (same facts, task-specific).
- Release the lease if you are not continuing:
  - task finished and cross-review PASS → `node scripts/agent/conductor.ts release T-NNNN --status done`
  - needs the human or 3rd failed attempt → `node scripts/agent/conductor.ts release T-NNNN --status blocked --reason "<text>"`
  - stopping for credit/quota/context but the task is fine → `node scripts/agent/conductor.ts release T-NNNN --status todo --reason "<text>"`
    (the next provider re-claims and continues on the same branch from `last_checkpoint`).
  - card in `review` waiting for the other provider → leave the status; the conductor dispatches
    `cross-review`.

## Step 4 — run log (if anything is left)

Skill `run-log`: write `Stopped because: <reason>` and the final commit sha.
